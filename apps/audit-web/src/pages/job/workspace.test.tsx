/**
 * The inspection workspace shows each person only the controls of their part.
 *
 * The server refuses a write from the wrong person whatever this screen
 * shows; these tests hold the courtesy - that an inspector's buttons are the
 * named inspector's alone, and the audit team sees no agency write at all.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { api } from '@/lib/api';
import type { JobDetail } from '@/lib/console-types';
import { Permission, holdsAll, holdsAny } from '@/lib/permissions';
import type { AuditRole } from '@/lib/types';
import { agency, sessionFor } from '@/test/session-fixture';
import { JobDetailPage } from '../JobDetailPage';
import { FIXTURE_JOB_ID, agencyJobFixture, staffJobFixture } from './fixtures';

function sessionState(role: AuditRole, permissions: string[], staff = false): SessionState {
  const session = sessionFor({ role, permissions, agency: staff ? null : agency('Northgate Inspection') });
  return {
    stage: 'READY',
    session,
    notice: null,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
    can: (...keys) => holdsAll(permissions, keys),
    canAny: (...keys) => holdsAny(permissions, keys),
  };
}

function renderWorkspace(detail: JobDetail, session: SessionState): void {
  vi.spyOn(api, 'get').mockResolvedValue(detail);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={session}>
            <MemoryRouter initialEntries={[`/jobs/${FIXTURE_JOB_ID}`]}>
              <Routes>
                <Route path="/jobs/:id" element={<JobDetailPage />} />
              </Routes>
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const INSPECTOR = [Permission.JOB_READ, Permission.JOB_PERFORM];
const COORDINATOR = [Permission.JOB_READ, Permission.JOB_ACCEPT, Permission.JOB_ASSIGN];
const STAFF = [Permission.DASHBOARD_READ, Permission.JOB_OVERSEE, Permission.RELEASE_REQUEST];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the inspection workspace', () => {
  it('gives the named inspector the checklist outcome buttons and the report submission', async () => {
    renderWorkspace(agencyJobFixture(), sessionState('INSPECTOR', INSPECTOR));

    expect(await screen.findByRole('heading', { name: 'INS-2026-000123' })).toBeDefined();
    expect(screen.getByRole('group', { name: 'Outcome for Product identity matches the order' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Conforms' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Submit for quality review' })).toBeDefined();
    expect(api.get).toHaveBeenCalledWith(`/audit/jobs/${FIXTURE_JOB_ID}`);
  });

  it('offers the named inspector Start once a job is assigned to them', async () => {
    renderWorkspace(agencyJobFixture({ job: { status: 'INSPECTOR_ASSIGNED' } }), sessionState('INSPECTOR', INSPECTOR));

    expect(await screen.findByRole('button', { name: 'Start the inspection' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save my declaration' })).toBeDefined();
  });

  it('shows an inspector who is not named on the job no inspector controls', async () => {
    renderWorkspace(
      agencyJobFixture({ me: { isNamedInspector: false, memberId: 'member-other' } }),
      sessionState('INSPECTOR', INSPECTOR),
    );

    expect(await screen.findByRole('heading', { name: 'INS-2026-000123' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Conforms' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit for quality review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start the inspection' })).toBeNull();
  });

  it('shows a coordinator acceptance but none of the inspector controls', async () => {
    renderWorkspace(
      agencyJobFixture({
        job: { status: 'REQUESTED', inspector: null },
        me: { isNamedInspector: false, role: 'COORDINATOR', memberId: 'member-coordinator' },
      }),
      sessionState('COORDINATOR', COORDINATOR),
    );

    expect(await screen.findAllByRole('button', { name: 'Accept the job' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Start the inspection' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Conforms' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit for quality review' })).toBeNull();
  });

  it('shows the audit team the job read-only, with no agency write controls', async () => {
    renderWorkspace(staffJobFixture(), sessionState('SUPERVISOR', STAFF, true));

    expect(await screen.findByRole('heading', { name: 'INS-2026-000123' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Conforms' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit for quality review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start the inspection' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept the job' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    // What staff may do instead: ask for a sub-lot release, read the timeline.
    expect(screen.getByRole('button', { name: 'Send the request' })).toBeDefined();
    expect(screen.getByText('Inspection booked with Northgate Inspection.')).toBeDefined();
  });

  it('shows the time in the job’s own time zone and the gate sentence the server gave', async () => {
    renderWorkspace(agencyJobFixture(), sessionState('INSPECTOR', INSPECTOR));

    expect(await screen.findByText('Dispatch is held until the inspection report is signed.')).toBeDefined();
    expect(screen.getByText('Time zone of the inspection: Asia/Kolkata')).toBeDefined();
    expect(screen.getByText('Independent agency')).toBeDefined();
  });
});
