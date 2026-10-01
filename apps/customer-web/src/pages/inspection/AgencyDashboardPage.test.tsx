import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgencyDashboardPage } from './AgencyPages';
import { renderWithProviders } from '@/test/harness';
import { fetchAgencyDashboard, fetchAgencyMe, type AgencyDashboard } from '@/lib/inspection';

vi.mock('@/lib/inspection', async (original) => ({
  ...await original<typeof import('@/lib/inspection')>(),
  fetchAgencyMe: vi.fn(),
  fetchAgencyDashboard: vi.fn(),
  fetchAgencyCalendar: vi.fn(() => Promise.resolve({ capacity: 2, days: [] })),
}));

const past = '2026-01-01T00:00:00Z';
const future = '2099-01-01T00:00:00Z';

const dashboard: AgencyDashboard = {
  counts: { offered: 1, toAssign: 0, assigned: 0, inProgress: 1, awaitingQa: 0, completed: 1, overdue: 1 },
  jobs: [
    { id: 'J1', jobNumber: 'INS-LATE', status: 'REQUESTED', scheduledFor: future, acceptDueAt: past, reportDueAt: future, slaState: 'ACCEPT_OVERDUE', inspectorMemberId: null },
    { id: 'J2', jobNumber: 'INS-REPEAT', kind: 'REINSPECTION', status: 'IN_PROGRESS', scheduledFor: future, acceptDueAt: future, reportDueAt: future, slaState: 'ON_TIME', inspectorMemberId: 'M1' },
  ],
  inspectors: [{ id: 'M1', fullName: 'Priya Inspector', role: 'INSPECTOR', status: 'ACTIVE', identityVerifiedAt: past, credentialExpiresAt: future }],
  reports: [{ id: 'R1', jobId: 'J0', jobNumber: 'INS-DONE', revision: 1, status: 'SIGNED', result: 'FAIL', submittedAt: past, signedAt: past, returnedAt: null }],
  invoices: [{ id: 'I1', jobNumber: 'INS-DONE', invoiceNumber: 'INV-77', amountMinor: '12345', currency: 'INR', payer: 'BUYER', status: 'SUBMITTED' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchAgencyMe).mockResolvedValue({
    membership: { agencyName: 'Independent QA', fullName: 'Coordinator', role: 'COORDINATOR', permissions: ['inspection.invoice.write'] },
  });
  vi.mocked(fetchAgencyDashboard).mockResolvedValue(dashboard);
});

describe('the agency dashboard', () => {
  it('shows assignments, the overdue SLA, inspectors, reports and invoices', async () => {
    renderWithProviders(<AgencyDashboardPage />);

    // Assignments, with the inspector named on the job that has one.
    expect((await screen.findAllByRole('link', { name: 'INS-LATE' })).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'INS-REPEAT' })).toBeInTheDocument();
    expect(screen.getAllByText('Priya Inspector').length).toBeGreaterThan(0);

    // The overdue job appears a second time, in the SLA list, and only it does.
    expect(screen.getAllByRole('link', { name: 'INS-LATE' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'INS-REPEAT' })).toHaveLength(1);

    // Reports and invoices.
    const report = screen.getByRole('link', { name: 'INS-DONE' }).parentElement;
    expect(report).not.toBeNull();
    expect(within(report as HTMLElement).getByText('FAIL')).toBeInTheDocument();
    expect(within(report as HTMLElement).getByText('SIGNED')).toBeInTheDocument();
    expect(screen.getByText('INV-77')).toBeInTheDocument();
  });

  it('shows no SLA list when every job is on time', async () => {
    vi.mocked(fetchAgencyDashboard).mockResolvedValue({ ...dashboard, jobs: dashboard.jobs.slice(1), reports: [] });
    renderWithProviders(<AgencyDashboardPage />);
    expect(await screen.findByRole('link', { name: 'INS-REPEAT' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'INS-LATE' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'INS-DONE' })).not.toBeInTheDocument();
  });
});
