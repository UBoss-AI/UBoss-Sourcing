/**
 * The operator's destination and category trade rules (JOURNEY-049) - staff
 * CRUD, every write audited.
 *
 * A rule matches by destination ('' for every destination), category (and
 * everything beneath it, or none for every category) and HS prefix ('' for
 * every code). It can mark the goods restricted or prohibited there, require a
 * document from a named party, and require the HS code to be verified by staff
 * first. What a match does to a seller order is decided in
 * `domain/compliance-hold.ts`.
 */
import { z } from 'zod';
import { badRequest, ErrorCode, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import type { SettingsActor } from '../settings/settings.service.js';

/** Trade document kinds a rule may require. `CATEGORY:<CODE>` names a category document. */
const DOCUMENT_KIND = /^(CERTIFICATE_OF_ORIGIN|SHIPPING_BILL|BILL_OF_LADING|AIR_WAYBILL|INSPECTION_CERTIFICATE|EXPORT_LICENCE|IMPORT_LICENCE|OTHER|CATEGORY:[A-Z0-9_-]{1,40})$/;

export const tradeRuleInput = z
  .object({
    name: z.string().trim().min(3).max(160),
    /** Two letters, or '' for every destination. */
    destinationCountry: z
      .string()
      .trim()
      .regex(/^([A-Za-z]{2})?$/)
      .transform((value) => value.toUpperCase())
      .default(''),
    categoryId: z.string().length(26).nullable().optional(),
    /** Digits only, or '' for every code. */
    hsPrefix: z
      .string()
      .trim()
      .regex(/^[0-9]{0,10}$/)
      .default(''),
    restriction: z.enum(['NONE', 'RESTRICTED', 'PROHIBITED']).default('NONE'),
    requiredDocumentKind: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .nullable()
      .optional(),
    requiredDocumentName: z.string().trim().max(160).nullable().optional(),
    responsibleParty: z.enum(['SELLER', 'BUYER', 'FORWARDER', 'OPERATOR']).default('SELLER'),
    requiresHsVerification: z.boolean().default(false),
    documentBuyerVisible: z.boolean().default(true),
    note: z.string().trim().max(1000).nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();
export type TradeRuleInput = z.infer<typeof tradeRuleInput>;

export interface TradeRuleView {
  id: string;
  name: string;
  destinationCountry: string;
  category: { id: string; name: string } | null;
  hsPrefix: string;
  restriction: 'NONE' | 'RESTRICTED' | 'PROHIBITED';
  requiredDocumentKind: string | null;
  requiredDocumentName: string | null;
  responsibleParty: 'SELLER' | 'BUYER' | 'FORWARDER' | 'OPERATOR';
  requiresHsVerification: boolean;
  documentBuyerVisible: boolean;
  note: string | null;
  isActive: boolean;
  updatedAt: string;
}

type Row = Awaited<ReturnType<typeof prisma.tradeComplianceRule.findUniqueOrThrow>>;

function view(row: Row, categories: ReadonlyMap<string, string>): TradeRuleView {
  return {
    id: row.id,
    name: row.name,
    destinationCountry: row.destinationCountry,
    category: row.categoryId === null ? null : { id: row.categoryId, name: categories.get(row.categoryId) ?? '' },
    hsPrefix: row.hsPrefix,
    restriction: row.restriction,
    requiredDocumentKind: row.requiredDocumentKind,
    requiredDocumentName: row.requiredDocumentName,
    responsibleParty: row.responsibleParty,
    requiresHsVerification: row.requiresHsVerification,
    documentBuyerVisible: row.documentBuyerVisible,
    note: row.note,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function categoryNames(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await prisma.category.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
  return new Map(rows.map((row) => [row.id, row.name]));
}

function snapshot(rule: TradeRuleView): Record<string, unknown> {
  return {
    name: rule.name,
    destinationCountry: rule.destinationCountry,
    categoryId: rule.category?.id ?? null,
    hsPrefix: rule.hsPrefix,
    restriction: rule.restriction,
    requiredDocumentKind: rule.requiredDocumentKind,
    responsibleParty: rule.responsibleParty,
    requiresHsVerification: rule.requiresHsVerification,
    isActive: rule.isActive,
  };
}

export async function listTradeRules(filter: { destinationCountry?: string | undefined }): Promise<TradeRuleView[]> {
  const rows = await prisma.tradeComplianceRule.findMany({
    where:
      filter.destinationCountry === undefined
        ? {}
        : { destinationCountry: { in: ['', filter.destinationCountry.toUpperCase()] } },
    orderBy: [{ destinationCountry: 'asc' }, { name: 'asc' }],
    take: 1000,
  });
  const names = await categoryNames(rows.map((row) => row.categoryId));
  return rows.map((row) => view(row, names));
}

async function columnsFor(input: TradeRuleInput) {
  const invalid = (field: string, code: string, message: string) =>
    badRequest(ErrorCode.VALIDATION_FAILED, message, [{ field, code }]);

  const categoryId = input.categoryId ?? null;
  if (categoryId !== null) {
    const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
    if (category === null) throw invalid('categoryId', 'NOT_FOUND', 'That category does not exist.');
  }

  const kind = input.requiredDocumentKind ?? null;
  const documentKind = kind === null || kind === '' ? null : kind;
  if (documentKind !== null && !DOCUMENT_KIND.test(documentKind)) {
    throw invalid('requiredDocumentKind', 'UNKNOWN_KIND', 'Choose a document kind, or CATEGORY: followed by a code.');
  }
  if (input.restriction === 'RESTRICTED' && documentKind === null) {
    throw invalid('requiredDocumentKind', 'REQUIRED', 'A restricted rule names the document that allows the goods.');
  }
  if (input.restriction === 'NONE' && documentKind === null && !input.requiresHsVerification) {
    throw invalid('restriction', 'NO_EFFECT', 'This rule would do nothing: require a document, verification or a restriction.');
  }
  const documentName = input.requiredDocumentName ?? null;
  return {
    categoryId,
    requiredDocumentKind: documentKind,
    requiredDocumentName: documentKind === null ? null : documentName === '' ? null : documentName,
  };
}

export async function saveTradeRule(id: string | null, input: TradeRuleInput, actor: SettingsActor): Promise<TradeRuleView> {
  const columns = await columnsFor(input);
  const data = {
    name: input.name,
    destinationCountry: input.destinationCountry,
    hsPrefix: input.hsPrefix,
    restriction: input.restriction,
    responsibleParty: input.responsibleParty,
    requiresHsVerification: input.requiresHsVerification,
    documentBuyerVisible: input.documentBuyerVisible,
    note: input.note === undefined || input.note === null || input.note === '' ? null : input.note,
    isActive: input.isActive,
    updatedByUserId: actor.userId,
    ...columns,
  };

  return prisma.$transaction(async (tx) => {
    const before = id === null ? null : await tx.tradeComplianceRule.findUnique({ where: { id } });
    if (id !== null && before === null) throw notFound('Trade rule');
    const row =
      id === null
        ? await tx.tradeComplianceRule.create({ data: { id: newId(), createdByUserId: actor.userId, ...data } })
        : await tx.tradeComplianceRule.update({ where: { id }, data });
    const names = await categoryNames([row.categoryId, before?.categoryId ?? null]);
    const after = view(row, names);
    await recordAudit(
      {
        action: AuditAction.TRADE_RULE_SAVED,
        resourceType: 'trade_compliance_rule',
        resourceId: row.id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: before === null ? null : snapshot(view(before, names)),
        after: snapshot(after),
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return after;
  });
}

export async function deleteTradeRule(id: string, actor: SettingsActor): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const before = await tx.tradeComplianceRule.findUnique({ where: { id } });
    if (before === null) throw notFound('Trade rule');
    await tx.tradeComplianceRule.delete({ where: { id } });
    await recordAudit(
      {
        action: AuditAction.TRADE_RULE_DELETED,
        resourceType: 'trade_compliance_rule',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: snapshot(view(before, await categoryNames([before.categoryId]))),
        after: null,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}
