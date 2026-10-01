/**
 * Master data (Master row 75): units of measure, Incoterms and inspection
 * defect codes, maintained by an administrator.
 *
 * Categories and currencies already have their own tables and screens; these
 * three lists are plain code + name pairs, so they share one table keyed by
 * kind. An entry is retired by switching it off, never deleted, because a
 * code already printed on a document must keep meaning what it meant.
 */
import { conflict, ErrorCode, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

export const MASTER_DATA_KINDS = ['UOM', 'INCOTERM', 'DEFECT_CODE'] as const;
export type MasterDataKindValue = (typeof MASTER_DATA_KINDS)[number];
export type DefectSeverityValue = 'CRITICAL' | 'MAJOR' | 'MINOR';

export interface MasterDataActor {
  userId: string;
  email: string;
  ipAddress?: string;
  correlationId?: string;
}

export interface MasterDataView {
  id: string;
  kind: MasterDataKindValue;
  code: string;
  name: string;
  description: string | null;
  defaultSeverity: DefectSeverityValue | null;
  sortOrder: number;
  isActive: boolean;
}

export interface MasterDataInput {
  code?: string;
  name?: string;
  description?: string | null;
  defaultSeverity?: DefectSeverityValue | null;
  sortOrder?: number;
  isActive?: boolean;
}

function view(row: {
  id: string;
  kind: MasterDataKindValue;
  code: string;
  name: string;
  description: string | null;
  defaultSeverity: DefectSeverityValue | null;
  sortOrder: number;
  isActive: boolean;
}): MasterDataView {
  return {
    id: row.id,
    kind: row.kind,
    code: row.code,
    name: row.name,
    description: row.description,
    defaultSeverity: row.defaultSeverity,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  };
}

/** Codes are stored upper-case so "kg" and "KG" cannot both exist. */
function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

export async function listMasterData(
  kind: MasterDataKindValue,
  options: { activeOnly?: boolean } = {},
): Promise<MasterDataView[]> {
  const rows = await prisma.masterDataEntry.findMany({
    where: { kind, ...(options.activeOnly === true ? { isActive: true } : {}) },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  });
  return rows.map(view);
}

async function assertCodeFree(kind: MasterDataKindValue, code: string, exceptId?: string): Promise<void> {
  const clash = await prisma.masterDataEntry.findUnique({
    where: { kind_code: { kind, code } },
    select: { id: true },
  });
  if (clash !== null && clash.id !== exceptId) {
    throw conflict(ErrorCode.CONFLICT, 'That code is already in this list.');
  }
}

export async function createMasterData(
  kind: MasterDataKindValue,
  input: MasterDataInput & { code: string; name: string },
  actor: MasterDataActor,
): Promise<MasterDataView> {
  const code = normaliseCode(input.code);
  await assertCodeFree(kind, code);

  const id = newId();
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.masterDataEntry.create({
      data: {
        id,
        kind,
        code,
        name: input.name.trim(),
        description: input.description ?? null,
        defaultSeverity: kind === 'DEFECT_CODE' ? (input.defaultSeverity ?? null) : null,
        sortOrder: input.sortOrder ?? 0,
        isActive: input.isActive ?? true,
      },
    });
    await recordAudit(
      {
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'master_data_entry',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: null,
        after: { kind, code, name: created.name, isActive: created.isActive },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return created;
  });
  return view(row);
}

export async function updateMasterData(
  kind: MasterDataKindValue,
  id: string,
  input: MasterDataInput,
  actor: MasterDataActor,
): Promise<MasterDataView> {
  const existing = await prisma.masterDataEntry.findUnique({ where: { id } });
  if (existing?.kind !== kind) throw notFound('Master data entry');

  const code = input.code === undefined ? undefined : normaliseCode(input.code);
  if (code !== undefined && code !== existing.code) await assertCodeFree(kind, code, id);

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.masterDataEntry.update({
      where: { id },
      data: {
        ...(code !== undefined ? { code } : {}),
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.defaultSeverity !== undefined && kind === 'DEFECT_CODE'
          ? { defaultSeverity: input.defaultSeverity }
          : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await recordAudit(
      {
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'master_data_entry',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { code: existing.code, name: existing.name, isActive: existing.isActive },
        after: { code: updated.code, name: updated.name, isActive: updated.isActive },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return updated;
  });
  return view(row);
}
