/**
 * What a preorder chat is about, as the server sees it.
 *
 * The browser says WHICH product, option, unit, quantity and date. Everything
 * else on the context card - the name, the picture, the seller, the SKU, the
 * minimum, how many pieces a 40-ft container is - is read here from the
 * catalogue and the preorder terms, so a customer cannot open a conversation
 * that claims a product costs something it does not, or that a container
 * holds a number of pieces the seller never verified.
 *
 * The snapshot is written once, when the conversation starts, and never
 * rewritten. A product renamed or re-priced next month must not change what an
 * old negotiation was about; staff see the product as it is now through a link
 * beside it.
 *
 * WHAT IS NOT IN IT
 *
 * No stock figure, no capacity, no cost, no margin, no seller id and no other
 * buyer. The customer is shown this snapshot back, so it holds only what the
 * product page already shows them.
 */
import { z } from 'zod';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { evaluateEligibility } from '../preorders/policy.service.js';
import { marketplaceNameFrom } from '../settings/marketplace-name.js';

/** The three units a customer can ask about in chat. */
export const CHAT_ORDERING_UNITS = ['PIECE', 'CONTAINER_20_FT', 'CONTAINER_40_FT'] as const;
export type ChatOrderingUnit = (typeof CHAT_ORDERING_UNITS)[number];

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Not a real date.');

/** What the browser may say about the conversation it is starting. */
export const chatContextInputSchema = z
  .object({
    productId: z.string().length(26),
    variantId: z.string().length(26).nullable().default(null),
    orderingUnit: z.enum(CHAT_ORDERING_UNITS).default('PIECE'),
    unitQuantity: z.number().int().positive().max(1_000_000_000).nullable().default(null),
    desiredDeliveryDate: isoDay.nullable().default(null),
  })
  .strict();

export type ChatContextInput = z.infer<typeof chatContextInputSchema>;

export interface ChatContextSnapshot {
  version: 1;
  capturedAt: string;
  product: {
    id: string;
    name: string;
    slug: string;
    sku: string;
    imageUrl: string | null;
  };
  variant: { id: string; name: string; sku: string } | null;
  seller: {
    /** The trading name the product page shows, or the store's own name. */
    name: string;
    isOperator: boolean;
  };
  preorder: {
    available: boolean;
    /** The minimum, in pieces, where preorder terms exist. */
    minimumBaseUnits: number | null;
    /** How the seller states it ("10 UK pallets"), for the card. */
    moqUnit: string | null;
    moqQuantity: number | null;
    /** Pieces per unit the customer could ask for, verified figures only. */
    unitSizes: { unit: ChatOrderingUnit; baseUnits: number | null }[];
  };
  request: {
    orderingUnit: ChatOrderingUnit;
    unitQuantity: number | null;
    /**
     * `unitQuantity` in pieces, from the seller's verified loading. Null when
     * no quantity was given or the container has no verified figure - never
     * a nominal "about 20,000".
     */
    baseUnits: number | null;
    desiredDeliveryDate: string | null;
  };
}

/** Internal ids the conversation row keeps and the snapshot does not show. */
export interface ChatContextKeys {
  productId: string;
  variantId: string | null;
  variantKey: string;
  sellerAccountId: string | null;
  offerId: string | null;
  productName: string;
  productSku: string;
  sellerName: string;
}

export interface BuiltChatContext {
  snapshot: ChatContextSnapshot;
  keys: ChatContextKeys;
}

/**
 * Read the product and its preorder terms and build the snapshot.
 *
 * 404 for a product that is not on sale - a customer can only ask about
 * something they can see - and 400 for an option that is not this product's.
 */
export async function buildChatContext(input: ChatContextInput): Promise<BuiltChatContext> {
  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: {
      id: true,
      name: true,
      slug: true,
      sku: true,
      status: true,
      isPublished: true,
      archivedAt: true,
      media: {
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
        take: 1,
        select: { media: { select: { url: true } } },
      },
    },
  });

  if (
    product === null ||
    product.status !== 'ACTIVE' ||
    !product.isPublished ||
    product.archivedAt !== null
  ) {
    throw notFound('Product');
  }

  let variant: { id: string; name: string; sku: string } | null = null;
  if (input.variantId !== null) {
    const row = await prisma.productVariant.findFirst({
      where: { id: input.variantId, productId: product.id, archivedAt: null },
      select: { id: true, name: true, sku: true },
    });
    if (row === null) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'That option is not part of this product.', [
        { field: 'variantId', code: 'NOT_THIS_PRODUCT' },
      ]);
    }
    variant = row;
  }

  const eligibility = await evaluateEligibility({
    productId: product.id,
    variantId: variant?.id ?? null,
  });

  const offer = eligibility.offer;
  // The operator's own trading name for its own products - every buyer of this
  // software runs their own marketplace, so never a literal.
  const operatorName =
    offer === null || offer.sellerAccountId === null
      ? marketplaceNameFrom(
          (await prisma.businessProfile.findFirst({ select: { displayName: true } }))?.displayName,
        )
      : null;
  const sellerName = operatorName ?? offer?.sellerDisplayName ?? marketplaceNameFrom(null);

  const unitSizes: { unit: ChatOrderingUnit; baseUnits: number | null }[] = CHAT_ORDERING_UNITS.map(
    (unit) => {
      if (unit === 'PIECE') return { unit, baseUnits: 1 };
      if (!eligibility.available) return { unit, baseUnits: null };
      const option = eligibility.containerOptions.find((candidate) => candidate.unit === unit);
      return {
        unit,
        baseUnits: option?.available === true ? option.piecesPerContainer : null,
      };
    },
  );

  const size = unitSizes.find((entry) => entry.unit === input.orderingUnit)?.baseUnits ?? null;
  const baseUnits =
    input.unitQuantity === null || size === null ? null : input.unitQuantity * size;

  const snapshot: ChatContextSnapshot = {
    version: 1,
    capturedAt: new Date().toISOString(),
    product: {
      id: product.id,
      name: product.name,
      slug: product.slug,
      sku: product.sku,
      imageUrl: product.media[0]?.media.url ?? null,
    },
    variant,
    seller: { name: sellerName, isOperator: operatorName !== null },
    preorder: eligibility.available
      ? {
          available: true,
          minimumBaseUnits: eligibility.rules.minimumBaseUnits,
          moqUnit: eligibility.policy.moqUnit,
          moqQuantity: eligibility.policy.moqQuantity,
          unitSizes,
        }
      : {
          available: false,
          minimumBaseUnits: null,
          moqUnit: null,
          moqQuantity: null,
          unitSizes,
        },
    request: {
      orderingUnit: input.orderingUnit,
      unitQuantity: input.unitQuantity,
      baseUnits,
      desiredDeliveryDate: input.desiredDeliveryDate,
    },
  };

  return {
    snapshot,
    keys: {
      productId: product.id,
      variantId: variant?.id ?? null,
      variantKey: variant?.id ?? '',
      sellerAccountId: offer?.sellerAccountId ?? null,
      offerId: offer?.id ?? null,
      productName: product.name.slice(0, 255),
      productSku: (variant?.sku ?? product.sku).slice(0, 96),
      sellerName: sellerName.slice(0, 255),
    },
  };
}

/** Read a stored snapshot defensively - it is JSON, and old rows outlive code. */
export function readSnapshot(value: unknown): ChatContextSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ChatContextSnapshot>;
  if (candidate.version !== 1 || typeof candidate.product !== 'object') return null;
  return candidate as ChatContextSnapshot;
}
