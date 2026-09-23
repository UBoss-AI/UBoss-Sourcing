/**
 * Deciding which of a seller's methods carries a particular consignment.
 *
 * The bridge between `domain/seller-fulfilment.ts`, which holds the rules and
 * knows nothing about a database, and `shipment-create.service.ts`, which
 * raises the consignment. This file loads the candidates, asks the pure
 * function, and writes the answer onto the shipment.
 *
 * WHY THE ANSWER IS WRITTEN RATHER THAN LOOKED UP LATER
 *
 * A seller switches from their own vans to DHL in March. Every consignment
 * they sent in February must go on saying it went by van - not because the
 * history is sentimental, but because a customer disputing a February delivery
 * is disputing what actually happened, and a screen that recomputed the answer
 * from today's configuration would tell them something false with complete
 * confidence.
 *
 * So `sellerFulfilmentMethodId`, `fulfilmentSelectionSource`,
 * `fulfilmentSelectionRuleId` and `fulfilmentSelectionReason` are written once,
 * when the consignment is raised, and nothing rewrites them.
 *
 * WHAT HAPPENS WHEN NOTHING IS ELIGIBLE
 *
 * The consignment is still raised, with `MANUAL_REVIEW` and a reason listing
 * what was considered and why each was passed over. It is NOT sent by
 * something unapproved because nothing else was left: a parcel that waits for
 * a person is recoverable, and a parcel handed to a carrier that was not
 * allowed to hold it is not.
 */
import type { FulfilmentSelectionSource } from '../../generated/prisma/enums.js';
import {
  explainMethodRefusal,
  selectFulfilmentMethod,
  type CandidateMethod,
  type CandidateRule,
  type ConsignmentNeeds,
  type RuleContext,
} from '../../domain/seller-fulfilment.js';
import { prisma } from '../../infra/prisma.js';

export interface SelectionOutcome {
  fulfilmentMethodId: string | null;
  sellerCarrierConnectionId: string | null;
  /**
   * The delivery company behind the chosen method, where there is one.
   *
   * Null for an integrated carrier, whose account is named by
   * `sellerCarrierConnectionId` instead - DHL is not a tenant of this
   * marketplace and has no partner row, nor should it.
   *
   * It is here because choosing the METHOD is not the same as the consignment
   * reaching anybody. Without this the caller writes which method was picked
   * and then leaves the parcel assigned to nobody: it never appears on the
   * fleet's own board, and no van can be booked for it.
   */
  logisticsPartnerId: string | null;
  source: FulfilmentSelectionSource;
  ruleId: string | null;
  /** Stored on the consignment and shown to the seller, in words. */
  reason: string;
  /** The public name a buyer is told, where one was chosen. */
  publicDisplayName: string | null;
}

/**
 * Load every method this seller has, reduced to what the picker needs.
 *
 * `targetIsLive` is resolved HERE rather than in the pure function, because
 * what "live" means differs per mode - an ACTIVE carrier connection, or an
 * ACTIVE logistics organisation - and `domain/` does not read a database.
 *
 * `serviceCountries` is null where the organisation has declared no regions at
 * all, which is read as "unconfigured, no restriction" rather than as
 * "nowhere". An empty service-area table means nobody has said yet; treating
 * it as a refusal would stop every seller who has not filled that screen in.
 */
async function candidatesFor(sellerAccountId: string): Promise<CandidateMethod[]> {
  const methods = await prisma.sellerFulfilmentMethod.findMany({
    where: { sellerAccountId, archivedAt: null },
    include: {
      carrierConnection: { select: { id: true, state: true } },
      logisticsPartner: {
        select: {
          id: true,
          status: true,
          archivedAt: true,
          regions: {
            where: { isActive: true, isExclusion: false, supportsDelivery: true },
            select: { countryCode: true },
          },
          capabilities: { where: { state: 'APPROVED' }, select: { kind: true } },
        },
      },
    },
  });

  return methods.map((method) => {
    const partner = method.logisticsPartner;
    const connection = method.carrierConnection;

    const targetIsLive =
      method.mode === 'OPERATOR_FULFILLED'
        ? true
        : method.mode === 'INTEGRATED_CARRIER'
          ? connection?.state === 'ACTIVE'
          : partner !== null && partner.archivedAt === null && partner.status === 'ACTIVE';

    const countries = partner === null ? [] : partner.regions.map((region) => region.countryCode);

    /*
     * AN EMPTY CAPABILITY LIST IS NOT "ANYTHING GOES".
     *
     * This is the difference between a claim and an approval, and getting it
     * the other way round is how reagents end up in an unrefrigerated van.
     *
     *   - An organisation we hold capabilities for (a seller's own arm, a
     *     dedicated partner) is approved for EXACTLY what is in the table. An
     *     empty table means nothing special has been approved, so a
     *     consignment needing cold chain finds it missing and is not sent.
     *     Reading empty as unrestricted would mean a brand-new organisation,
     *     approved for nothing, could carry anything.
     *
     *   - An external carrier account is null - "this system does not know" -
     *     because DHL's approvals are DHL's, are not in this database, and
     *     inventing them here would be worse than deferring. The carrier
     *     refuses at booking if it will not take the goods, which is the
     *     authority that actually holds the answer.
     *
     * Service COUNTRIES are treated the other way, and deliberately: an empty
     * region table means nobody has filled that screen in yet, not that the
     * organisation serves nowhere. Refusing on it would stop every seller who
     * had not got to it.
     */
    const capabilities: string[] | null =
      partner === null ? null : partner.capabilities.map((row) => row.kind);

    return {
      id: method.id,
      mode: method.mode,
      status: method.status,
      role: method.role,
      publicDisplayName: method.publicDisplayName,
      allowsInternational: method.allowsInternational,
      targetIsLive,
      serviceCountries: countries.length === 0 ? null : countries,
      approvedCapabilities: capabilities,
      /*
       * No per-method weight ceiling yet - that lives on the pickup profile
       * and the service region, and is applied when a consignment is priced.
       * Null here means "the picker does not refuse on weight", which is
       * honest: refusing on a limit nobody has configured would be inventing
       * one.
       */
      maxWeightGrams: null,
    };
  });
}

async function rulesFor(sellerAccountId: string): Promise<CandidateRule[]> {
  const rules = await prisma.sellerFulfilmentRule.findMany({
    where: { sellerAccountId, archivedAt: null },
    orderBy: [{ precedence: 'asc' }, { createdAt: 'asc' }],
  });

  return rules.map((rule) => ({
    id: rule.id,
    scope: rule.scope,
    precedence: rule.precedence,
    fulfilmentMethodId: rule.fulfilmentMethodId,
    isActive: rule.isActive,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    note: rule.note,
    sellerOfferId: rule.sellerOfferId,
    sellerLocationId: rule.sellerLocationId,
    destinationCountry: rule.destinationCountry,
    destinationPostalPrefix: rule.destinationPostalPrefix,
  }));
}

export interface SelectionRequest {
  sellerAccountId: string;
  /** The listings on this seller's share of the order. */
  sellerOfferIds: readonly string[];
  sellerLocationId: string | null;
  needs: ConsignmentNeeds;
  destinationPostalCode: string | null;
}

/**
 * Choose a method, or say why nothing could be chosen.
 *
 * Never throws for "nothing eligible". A consignment that cannot be routed is
 * a consignment a person has to look at, and refusing to raise it at all would
 * mean a paid order sitting nowhere, invisible, because its seller had not
 * finished a settings screen.
 */
export async function chooseMethodForConsignment(
  request: SelectionRequest,
): Promise<SelectionOutcome> {
  const [methods, rules] = await Promise.all([
    candidatesFor(request.sellerAccountId),
    rulesFor(request.sellerAccountId),
  ]);

  if (methods.length === 0) {
    return {
      fulfilmentMethodId: null,
      sellerCarrierConnectionId: null,
      logisticsPartnerId: null,
      source: 'MANUAL_REVIEW',
      ruleId: null,
      reason:
        'This seller has not set up any way of delivering yet, so a person needs to choose one.',
      publicDisplayName: null,
    };
  }

  const context: RuleContext = {
    sellerOfferIds: request.sellerOfferIds,
    sellerLocationId: request.sellerLocationId,
    destinationCountry: request.needs.destinationCountry,
    destinationPostalCode: request.destinationPostalCode,
  };

  const selection = selectFulfilmentMethod(rules, methods, request.needs, context);

  if (!selection.chosen) {
    /*
     * Every method considered, and why each was passed over.
     *
     * "No carrier available" with nothing else in it is a support ticket. The
     * seller reading this sees which of their own methods was tried and what
     * stopped it, which is usually enough to fix without asking anybody.
     */
    const lines = selection.considered.map((entry) =>
      explainMethodRefusal(entry.refusal, entry.name),
    );

    return {
      fulfilmentMethodId: null,
      sellerCarrierConnectionId: null,
      logisticsPartnerId: null,
      source: 'MANUAL_REVIEW',
      ruleId: null,
      reason:
        lines.length === 0
          ? 'Nothing this seller has set up can carry this consignment.'
          : `Nothing eligible: ${lines.join(' ')}`,
      publicDisplayName: null,
    };
  }

  // Both targets. The connection, for an integrated carrier, so the shipment
  // points at the account it will actually be booked against; the partner, for
  // everything else, so the consignment can reach the people who will carry it.
  const target = await prisma.sellerFulfilmentMethod.findUnique({
    where: { id: selection.method.id },
    select: { sellerCarrierConnectionId: true, logisticsPartnerId: true },
  });

  return {
    fulfilmentMethodId: selection.method.id,
    sellerCarrierConnectionId: target?.sellerCarrierConnectionId ?? null,
    logisticsPartnerId: target?.logisticsPartnerId ?? null,
    source: selection.source,
    ruleId: selection.ruleId,
    reason: selection.reason,
    publicDisplayName: selection.method.publicDisplayName,
  };
}
