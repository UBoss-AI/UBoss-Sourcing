/**
 * The audit trail: one page of entries, and a CSV copy of the same filter.
 *
 * The export is a POST, not a link: producing the file writes an entry of its
 * own on the trail, and a state-changing request carries the CSRF token.
 */
import { ApiError, BASE_URL, request } from '@/lib/api';
import type { Pagination } from '@/lib/types';

export interface AuditDevice {
  browser: string | null;
  os: string | null;
}

export interface AuditEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorType: string;
  actorUserId: string | null;
  actorEmail: string | null;
  /** Role keys held when the entry was written. Null: none was recorded. */
  actorRoles: string[] | null;
  /** Why, where the entry states it. */
  reason: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  /** The full User-Agent header, as recorded. */
  userAgent: string | null;
  /** A summary of `userAgent`, e.g. Chrome and Windows. */
  device: AuditDevice | null;
  correlationId: string | null;
  createdAt: string;
}

export interface AuditFilter {
  action?: string;
  actorEmail?: string;
  resourceType?: string;
}

export interface AuditExportResult {
  /** Entries in the file. */
  rows: number;
  /** Entries that matched. More than `rows`: the row cap cut the file short. */
  total: number;
}

/** Mirrors AUDIT_EXPORT_MAX_ROWS in the backend. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

function compact(filter: AuditFilter): AuditFilter {
  return Object.fromEntries(
    Object.entries(filter).filter(([, value]) => typeof value === 'string' && value !== ''),
  );
}

function readCsrfToken(): string | null {
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('uboss_admin_csrf='));
  return match === undefined ? null : decodeURIComponent(match.slice('uboss_admin_csrf='.length));
}

async function saveCsv(filter: AuditFilter): Promise<AuditExportResult> {
  const csrf = readCsrfToken();
  const response = await fetch(
    new URL(`${BASE_URL}/admin/audit-logs/export`, window.location.origin).toString(),
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(csrf === null ? {} : { 'x-csrf-token': csrf }),
      },
      body: JSON.stringify(compact(filter)),
    },
  );

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const envelope =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error: { code: string; message: string } }).error
        : { code: 'UNEXPECTED_RESPONSE', message: `The server returned ${String(response.status)}.` };
    throw new ApiError(response.status, envelope);
  }

  const rows = Number(response.headers.get('x-audit-export-rows') ?? '0');
  const total = Number(response.headers.get('x-audit-export-total') ?? String(rows));
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? 'audit-log.csv';

  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);

  return { rows, total };
}

export const auditLogApi = {
  list: (filter: AuditFilter & { page: number; limit: number }) =>
    request<{ entries: AuditEntry[]; pagination: Pagination }>('/admin/audit-logs', {
      query: { ...compact(filter), page: filter.page, limit: filter.limit },
    }),
  exportCsv: saveCsv,
};
