/**
 * The audit log screen.
 *
 *   - each entry shows the role recorded when it was written, the reason where
 *     it states one, the address, and a device summary with the full header
 *     one hover away;
 *   - an entry that never recorded a role says so, rather than borrowing one;
 *   - "Download CSV" is there only for somebody holding audit.read AND
 *     export.create, sends the current filter, and says when the cap cut the
 *     file short.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import type { AuditEntry } from '@/lib/audit-log';
import de from '@/i18n/locales/de.json';
import el from '@/i18n/locales/el.json';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';
import fr from '@/i18n/locales/fr.json';
import it_ from '@/i18n/locales/it.json';
import nl from '@/i18n/locales/nl.json';
import pl from '@/i18n/locales/pl.json';
import { AuditPage } from './AuditPage';

vi.mock('@/lib/audit-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit-log')>();
  return { ...actual, auditLogApi: { list: vi.fn(), exportCsv: vi.fn() } };
});

const { auditLogApi } = await import('@/lib/audit-log');
const list = vi.mocked(auditLogApi.list);
const exportCsv = vi.mocked(auditLogApi.exportCsv);

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: '01AUDITENTRY00000000000001',
    action: 'customer.status_changed',
    resourceType: 'customer_profile',
    resourceId: '01CUSTOMER0000000000000001',
    actorType: 'ADMIN',
    actorUserId: '01STAFF0000000000000000001',
    actorEmail: 'finance@example.test',
    actorRoles: ['finance_approver'],
    reason: 'Chargeback pattern',
    before: { status: 'ACTIVE' },
    after: { status: 'SUSPENDED', reason: 'Chargeback pattern' },
    ipAddress: '203.0.113.71',
    userAgent: CHROME,
    device: { browser: 'Chrome', os: 'Windows' },
    correlationId: 'corr-1',
    createdAt: '2026-09-28T10:00:00.000Z',
    ...overrides,
  };
}

function renderAt(path: string, permissions: string[]): void {
  const session = {
    user: { id: 'u1', email: 'owner@example.test' },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    can: (permission: string) => permissions.includes(permission),
    canAny: (...wanted: string[]) => wanted.some((permission) => permissions.includes(permission)),
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={session}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/audit" element={<AuditPage />} />
              </Routes>
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function listed(entries: AuditEntry[]): void {
  list.mockResolvedValue({
    entries,
    pagination: { page: 1, limit: 25, total: entries.length, totalPages: 1 },
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AuditPage columns', () => {
  it('shows the role at the time, the reason, the address and the device', async () => {
    await i18n.changeLanguage('en');
    listed([entry()]);
    renderAt('/audit', ['audit.read']);

    const table = await screen.findByRole('table');
    await within(table).findByText('finance@example.test');

    expect(within(table).getByRole('columnheader', { name: 'Reason' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: 'Address and device' })).toBeTruthy();
    expect(within(table).getByLabelText('Role held when this was done').textContent).toContain(
      'Finance Approver',
    );
    expect(within(table).getByText('Chargeback pattern')).toBeTruthy();
    expect(within(table).getByText('203.0.113.71')).toBeTruthy();
    const device = within(table).getByText('Chrome on Windows');
    // The summary is an interpretation; the recorded header is the evidence.
    expect(device.getAttribute('title')).toBe(CHROME);
  });

  it('says when an entry recorded no role, and shows a dash for no reason or source', async () => {
    await i18n.changeLanguage('en');
    listed([entry({ actorRoles: null, reason: null, ipAddress: null, userAgent: null, device: null })]);
    renderAt('/audit', ['audit.read']);

    const table = await screen.findByRole('table');
    expect(await within(table).findByText('Role not recorded')).toBeTruthy();
    expect(within(table).queryByText('Finance Approver')).toBeNull();
    expect(within(table).queryByText('Chrome on Windows')).toBeNull();
  });

  it('sends the filters from the address bar, including the actor email', async () => {
    listed([]);
    renderAt('/audit?action=order.approved&actorEmail=finance@example.test', ['audit.read']);
    await waitFor(() => {
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'order.approved', actorEmail: 'finance@example.test' }),
      );
    });
  });
});

describe('AuditPage export', () => {
  it('is hidden from somebody who may read the log but not export', async () => {
    await i18n.changeLanguage('en');
    listed([entry()]);
    renderAt('/audit', ['audit.read']);
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Download CSV' })).toBeNull();
  });

  it('downloads the current filter and reports the count', async () => {
    await i18n.changeLanguage('en');
    listed([entry()]);
    exportCsv.mockResolvedValue({ rows: 1, total: 1 });
    renderAt('/audit?action=customer.status_changed', ['audit.read', 'export.create']);

    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));

    await waitFor(() => {
      expect(exportCsv).toHaveBeenCalledTimes(1);
    });
    expect(exportCsv).toHaveBeenCalledWith({
      action: 'customer.status_changed',
      actorEmail: '',
      resourceType: '',
    });
    expect(await screen.findByText('Entries in the file: 1.')).toBeTruthy();
  });

  it('says when the row cap cut the file short', async () => {
    await i18n.changeLanguage('en');
    listed([entry()]);
    exportCsv.mockResolvedValue({ rows: 10_000, total: 12_500 });
    renderAt('/audit', ['audit.read', 'export.create']);

    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));

    expect(await screen.findByText(/newest 10,000 of 12,500 matching entries/)).toBeTruthy();
  });

  it('has every new string in all eight languages', () => {
    const keys = [
      'audit.reason',
      'audit.source',
      'audit.roleAtTheTime',
      'audit.roleNotRecorded',
      'audit.browserOnOs',
      'audit.unknownDevice',
      'audit.downloadCsv',
      'audit.exporting',
      'audit.exportHint',
      'audit.exportDone',
      'audit.exportTruncated',
      'audit.exportFailed',
      'audit.exportNotAllowed',
    ];
    const locales: Record<string, Record<string, string>> = { en, de, el, es, fr, it: it_, nl, pl };
    for (const [language, strings] of Object.entries(locales)) {
      for (const key of keys) {
        expect(strings[key], `${language}:${key}`).toBeTruthy();
        if (language !== 'en') expect(strings[key], `${language}:${key}`).not.toBe(en[key as keyof typeof en]);
      }
    }
  });
});
