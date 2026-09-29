/**
 * The sourcing figures on the buyer dashboard (checklist Master row 15).
 *
 * Counts of requests, quotes, negotiations and samples, and the next things the
 * buyer has to do, all read from the buyer's own rows - nothing is estimated.
 *
 * Each block is measured on its own. A block whose query fails comes back as
 * `null` and is named in `unavailable`, so one broken figure never takes the
 * rest of the card (or the dashboard) down with it.
 */
import { prisma } from '../../infra/prisma.js';
import { logger } from '../../infra/logger.js';
import { buyerScopeWhere, type RfqBuyer } from './access.js';

export type RfqNextActionKind =
  | 'FINISH_DRAFT'
  | 'REVIEW_OFFER'
  | 'DEADLINE_PASSED'
  | 'CONFIRM_SAMPLE'
  | 'DECIDE_SAMPLE';

export interface RfqNextAction {
  kind: RfqNextActionKind;
  rfqId: string;
  rfqReference: string;
  rfqTitle: string;
  quoteId: string | null;
  sampleReference: string | null;
  at: string;
}

export interface RfqDashboardSummary {
  requests: { draft: number; open: number; awarded: number; closed: number } | null;
  quotes: { open: number; awaitingYou: number; shortlisted: number } | null;
  negotiations: { active: number; awaitingYou: number; accepted: number } | null;
  samples: { inProgress: number; awaitingYou: number; approved: number } | null;
  nextActions: RfqNextAction[] | null;
  unavailable: string[];
  generatedAt: string;
}

const NEXT_ACTION_LIMIT = 6;
const ACTIVE_SAMPLE = ['REQUESTED', 'ACCEPTED', 'SHIPPED', 'DELIVERED'] as const;

async function settle<T>(name: string, unavailable: string[], work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    logger.warn({ err: error, block: name }, 'rfq dashboard block failed');
    unavailable.push(name);
    return null;
  }
}

export async function buyerRfqSummary(buyer: RfqBuyer, now = new Date()): Promise<RfqDashboardSummary> {
  const scope = buyerScopeWhere(buyer);
  const unavailable: string[] = [];

  const requests = settle('requests', unavailable, async () => {
    const grouped = await prisma.rfqRequest.groupBy({ by: ['status'], where: scope, _count: { _all: true } });
    const count = (status: string): number => grouped.find((group) => group.status === status)?._count._all ?? 0;
    return { draft: count('DRAFT'), open: count('OPEN'), awarded: count('AWARDED'), closed: count('CLOSED') };
  });

  // Open quotes and the offer each one currently stands on; shared by two blocks.
  const openQuotes = prisma.rfqQuote.findMany({
    where: { status: 'OPEN', rfq: { AND: [scope, { status: 'OPEN' }] } },
    select: {
      id: true,
      rfqId: true,
      shortlisted: true,
      currentVersionId: true,
      currentVersionNumber: true,
      updatedAt: true,
      rfq: { select: { reference: true, title: true } },
    },
    take: 500,
  });
  const currentOffers = openQuotes.then(async (quotes) => {
    const ids = quotes.flatMap((quote) => (quote.currentVersionId === null ? [] : [quote.currentVersionId]));
    const versions = await prisma.rfqQuoteVersion.findMany({
      where: { id: { in: ids } },
      select: { id: true, authorParty: true, state: true, createdAt: true },
    });
    const byId = new Map(versions.map((version) => [version.id, version]));
    return quotes.map((quote) => {
      const offer = quote.currentVersionId === null ? undefined : byId.get(quote.currentVersionId);
      return { quote, offer, awaitingYou: offer?.authorParty === 'SUPPLIER' && offer.state === 'PROPOSED' };
    });
  });

  const quotes = settle('quotes', unavailable, async () => {
    const rows = await currentOffers;
    return {
      open: rows.length,
      awaitingYou: rows.filter((row) => row.awaitingYou).length,
      shortlisted: rows.filter((row) => row.quote.shortlisted).length,
    };
  });

  const negotiations = settle('negotiations', unavailable, async () => {
    const [rows, accepted] = await Promise.all([
      currentOffers,
      prisma.rfqQuote.count({ where: { status: 'ACCEPTED', rfq: scope } }),
    ]);
    const active = rows.filter((row) => row.quote.currentVersionNumber > 1);
    return { active: active.length, awaitingYou: active.filter((row) => row.awaitingYou).length, accepted };
  });

  const sampleRows = prisma.rfqSample.findMany({
    where: { rfq: scope, status: { in: [...ACTIVE_SAMPLE, 'APPROVED'] } },
    select: {
      status: true,
      reference: true,
      rfqId: true,
      updatedAt: true,
      rfq: { select: { reference: true, title: true } },
    },
    take: 500,
  });
  const samples = settle('samples', unavailable, async () => {
    const rows = await sampleRows;
    return {
      inProgress: rows.filter((row) => row.status !== 'APPROVED').length,
      awaitingYou: rows.filter((row) => row.status === 'SHIPPED' || row.status === 'DELIVERED').length,
      approved: rows.filter((row) => row.status === 'APPROVED').length,
    };
  });

  const nextActions = settle('nextActions', unavailable, async () => {
    const [drafts, pastDeadline, offers, activeSamples] = await Promise.all([
      prisma.rfqRequest.findMany({
        where: { AND: [scope, { status: 'DRAFT' }] },
        select: { id: true, reference: true, title: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: NEXT_ACTION_LIMIT,
      }),
      prisma.rfqRequest.findMany({
        where: { AND: [scope, { status: 'OPEN', responseDeadline: { lte: now } }] },
        select: { id: true, reference: true, title: true, responseDeadline: true },
        take: NEXT_ACTION_LIMIT,
      }),
      currentOffers,
      sampleRows,
    ]);
    const actions: RfqNextAction[] = [];
    for (const { quote, offer, awaitingYou } of offers) {
      if (!awaitingYou || offer === undefined) continue;
      actions.push({
        kind: 'REVIEW_OFFER',
        rfqId: quote.rfqId,
        rfqReference: quote.rfq.reference,
        rfqTitle: quote.rfq.title,
        quoteId: quote.id,
        sampleReference: null,
        at: offer.createdAt.toISOString(),
      });
    }
    for (const sample of activeSamples) {
      if (sample.status !== 'SHIPPED' && sample.status !== 'DELIVERED') continue;
      actions.push({
        kind: sample.status === 'SHIPPED' ? 'CONFIRM_SAMPLE' : 'DECIDE_SAMPLE',
        rfqId: sample.rfqId,
        rfqReference: sample.rfq.reference,
        rfqTitle: sample.rfq.title,
        quoteId: null,
        sampleReference: sample.reference,
        at: sample.updatedAt.toISOString(),
      });
    }
    for (const rfq of pastDeadline) {
      actions.push({
        kind: 'DEADLINE_PASSED',
        rfqId: rfq.id,
        rfqReference: rfq.reference,
        rfqTitle: rfq.title,
        quoteId: null,
        sampleReference: null,
        at: (rfq.responseDeadline ?? now).toISOString(),
      });
    }
    for (const draft of drafts) {
      actions.push({
        kind: 'FINISH_DRAFT',
        rfqId: draft.id,
        rfqReference: draft.reference,
        rfqTitle: draft.title,
        quoteId: null,
        sampleReference: null,
        at: draft.updatedAt.toISOString(),
      });
    }
    // Pushed in priority order: offers, samples, passed deadlines, drafts.
    return actions.slice(0, NEXT_ACTION_LIMIT);
  });

  const [requestsBlock, quotesBlock, negotiationsBlock, samplesBlock, actionsBlock] = await Promise.all([
    requests,
    quotes,
    negotiations,
    samples,
    nextActions,
  ]);
  return {
    requests: requestsBlock,
    quotes: quotesBlock,
    negotiations: negotiationsBlock,
    samples: samplesBlock,
    nextActions: actionsBlock,
    unavailable,
    generatedAt: now.toISOString(),
  };
}
