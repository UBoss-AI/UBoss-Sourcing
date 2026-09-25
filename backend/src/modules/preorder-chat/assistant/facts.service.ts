/**
 * The facts the preorder assistant answers from, and the signature that lets a
 * transcript be carried into a conversation without trusting the browser.
 *
 * FACTS
 *
 * Read from the same place the product page and the preorder form read them:
 * `buildChatContext` for the product (a product that is not on sale answers
 * 404, exactly as the chat does) and `evaluateEligibility` for the seller's
 * terms, verified container loading, stock on the listing and the delivery
 * window. A signed-in customer is answered for their default delivery address,
 * because the earliest date depends on where the goods are going - the same
 * rule as the eligibility route. Nothing here is a guess: a figure the seller
 * never gave is null, and `answers.ts` turns null into "the team will confirm".
 *
 * SIGNED ANSWERS
 *
 * The customer reads answers before any conversation exists, possibly before
 * they have signed in. When they ask for a person, the answers they read go
 * into the conversation for staff to see. The browser holds them in between,
 * so each answer is signed here with a key derived from the session secret,
 * over the product, the option, the answer and when it was given. The handoff
 * accepts only answers this server signed for this product in the last day:
 * the transcript staff read is exactly what the customer was shown, and a
 * browser cannot write words into the assistant's mouth.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../../config/env.js';
import { prisma } from '../../../infra/prisma.js';
import { evaluateEligibility } from '../../preorders/policy.service.js';
import { buildChatContext, type BuiltChatContext, type ChatContextInput } from '../context.service.js';
import type { FaqAnswer, FaqFacts } from './answers.js';

/** How long a signed answer may be carried before a handoff refuses it. */
export const ANSWER_TOKEN_TTL_MS = 24 * 60 * 60_000;

/** The seller's cancellation terms are shown as they wrote them - as text, bounded. */
const TERMS_MAX = 600;

function plainText(value: string | null, max: number): string | null {
  if (value === null) return null;
  // Control characters out (line breaks kept), then trimmed and bounded.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}

export interface FaqViewer {
  customerProfileId: string | null;
}

export interface GatheredFacts {
  built: BuiltChatContext;
  facts: FaqFacts;
}

export async function gatherFaqFacts(input: ChatContextInput, viewer: FaqViewer): Promise<GatheredFacts> {
  const built = await buildChatContext(input);

  const address =
    viewer.customerProfileId === null
      ? null
      : await prisma.address.findFirst({
          where: { customerProfileId: viewer.customerProfileId, archivedAt: null, isDefaultShipping: true },
          select: { country: true, timezone: true },
        });

  const eligibility = await evaluateEligibility({
    productId: built.keys.productId,
    variantId: built.keys.variantId,
    offerId: built.keys.offerId,
    destinationCountry: address?.country ?? null,
    timezone: address?.timezone ?? null,
  });

  const requestedBaseUnits = built.snapshot.request.baseUnits;
  const stockBaseUnits = eligibility.offer === null ? null : Math.max(0, eligibility.offer.availableQuantity);

  if (!eligibility.available) {
    return {
      built,
      facts: {
        open: false,
        moq: null,
        pricing: null,
        containers: { CONTAINER_20_FT: null, CONTAINER_40_FT: null },
        stockBaseUnits,
        requestedBaseUnits,
        window: null,
        allowSplitDelivery: null,
        allowPartialFulfilment: null,
        cancellationTerms: null,
        deliveryCountries: [],
      },
    };
  }

  const { policy, rules, offer } = eligibility;
  const container = (unit: 'CONTAINER_20_FT' | 'CONTAINER_40_FT'): FaqFacts['containers'][typeof unit] => {
    const option = eligibility.containerOptions.find((candidate) => candidate.unit === unit);
    if (option === undefined || !option.available || option.piecesPerContainer === null) return null;
    return {
      pieces: option.piecesPerContainer,
      cartons: option.cartonsPerContainer,
      piecesPerCarton: option.piecesPerCarton,
    };
  };

  return {
    built,
    facts: {
      open: true,
      moq: {
        minimumBaseUnits: rules.minimumBaseUnits,
        incrementBaseUnits: rules.incrementBaseUnits,
        maximumBaseUnits: rules.maximumBaseUnits,
        moqUnit: policy.moqUnit,
        moqQuantity: policy.moqQuantity,
      },
      pricing: {
        mode: policy.pricingMode,
        currency: offer.currency,
        bands: policy.tiers
          .filter((tier) => tier.currency === offer.currency && tier.unitPriceMinor > 0n)
          .sort((x, y) => x.minBaseUnits - y.minBaseUnits)
          .map((tier) => ({ minBaseUnits: tier.minBaseUnits, unitPriceMinor: tier.unitPriceMinor.toString() })),
      },
      containers: { CONTAINER_20_FT: container('CONTAINER_20_FT'), CONTAINER_40_FT: container('CONTAINER_40_FT') },
      stockBaseUnits,
      requestedBaseUnits,
      window: {
        earliest: eligibility.window.earliest,
        latest: eligibility.window.latest,
        hasPublishedTransit: eligibility.hasPublishedTransit,
      },
      allowSplitDelivery: policy.allowSplitDelivery,
      allowPartialFulfilment: policy.allowPartialFulfilment,
      cancellationTerms: plainText(policy.cancellationTerms, TERMS_MAX),
      deliveryCountries: eligibility.deliveryCountries.filter((code) => /^[A-Z]{2}$/.test(code)).slice(0, 60),
    },
  };
}

/** The greeting's first name: the first word of the profile's name, or null. */
export async function customerFirstName(customerProfileId: string | null): Promise<string | null> {
  if (customerProfileId === null) return null;
  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    select: { fullName: true },
  });
  const first = plainText(profile?.fullName ?? null, 200)?.split(/\s+/)[0] ?? null;
  return first === null || first.length === 0 ? null : first.slice(0, 40);
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function signingKey(): Buffer {
  // Derived, so the session secret itself never signs anything but sessions.
  return createHmac('sha256', env.SESSION_COOKIE_SECRET).update('uboss.preorder-assistant.answer.v1').digest();
}

/** JSON with keys in a fixed order, so the same answer always signs the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface SignedScope {
  productId: string;
  variantId: string | null;
}

export function signAnswer(scope: SignedScope, answer: FaqAnswer, askedAt: string): string {
  return createHmac('sha256', signingKey())
    .update(canonical({ scope, answer, askedAt }))
    .digest('base64url');
}

/** True when this server signed exactly this answer, for this product, recently. */
export function verifyAnswer(
  scope: SignedScope,
  answer: FaqAnswer,
  askedAt: string,
  token: string,
  now: Date = new Date(),
): boolean {
  const at = Date.parse(askedAt);
  if (Number.isNaN(at) || at > now.getTime() + 60_000 || now.getTime() - at > ANSWER_TOKEN_TTL_MS) return false;
  const expected = Buffer.from(signAnswer(scope, answer, askedAt));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
