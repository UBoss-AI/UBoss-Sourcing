import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgencyDashboardPage, AgencyJobPage } from './AgencyPages';
import { renderWithProviders } from '@/test/harness';
import { fetchAgencyDashboard, fetchAgencyJob, fetchAgencyMe, type AgencyDashboard } from '@/lib/inspection';

vi.mock('@/lib/inspection', async (original) => ({
  ...await original<typeof import('@/lib/inspection')>(),
  fetchAgencyDashboard: vi.fn(), fetchAgencyMe: vi.fn(), fetchAgencyJob: vi.fn(),
}));

const dashboard: AgencyDashboard = {
  counts: { offered: 0, toAssign: 0, assigned: 1, inProgress: 0, awaitingQa: 0, completed: 0, overdue: 1 },
  jobs: [{ id: 'J', jobNumber: 'INS-45', status: 'INSPECTOR_ASSIGNED', scheduledFor: '2026-09-30T10:00:00Z', acceptDueAt: '2026-09-29T10:00:00Z', reportDueAt: '2026-10-01T10:00:00Z', slaState: 'REPORT_OVERDUE', inspectorMemberId: 'I' }],
  inspectors: [{ id: 'I', fullName: 'Priya', role: 'INSPECTOR', status: 'ACTIVE', identityVerifiedAt: null, credentialExpiresAt: null }],
  invoices: [{ id: 'V', jobNumber: 'INS-45', invoiceNumber: 'INV-45', amountMinor: '12345', currency: 'INR', payer: 'BUYER', status: 'APPROVED' }],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchAgencyMe).mockResolvedValue({ membership: { agencyName: 'Independent QA', fullName: 'Coordinator', role: 'COORDINATOR', permissions: ['inspection.invoice.write'] } });
  vi.mocked(fetchAgencyDashboard).mockResolvedValue(dashboard);
});
describe('agency dashboard', () => {
  it('shows deadlines, SLA, assigned inspector, report links and exact invoice amounts', async () => {
    renderWithProviders(<AgencyDashboardPage />);
    expect((await screen.findAllByRole('link', { name: 'INS-45' })).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Report overdue').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Accept by:/)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/Report due:/)[0]).toBeInTheDocument();
    expect(screen.getAllByText('Inspector: Priya')[0]).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Report' })[0]).toHaveAttribute('href', '/inspection/jobs/J');
    expect(screen.getAllByText('INV-45')[0]).toBeInTheDocument();
    expect(screen.getAllByText(/123\.45/)[0]).toBeInTheDocument();
  });
  it('keeps invoice controls out of the inspector view and handles an empty assignment list', async () => {
    vi.mocked(fetchAgencyMe).mockResolvedValue({ membership: { agencyName: 'Independent QA', fullName: 'Inspector', role: 'INSPECTOR', permissions: [] } });
    vi.mocked(fetchAgencyDashboard).mockResolvedValue({ ...dashboard, jobs: [], inspectors: [], invoices: [] });
    renderWithProviders(<AgencyDashboardPage />);
    expect(await screen.findByText('No inspection jobs yet.')).toBeInTheDocument();
    expect(screen.queryByText('Invoices')).not.toBeInTheDocument();
  });
  it('retries a failed dashboard read', async () => {
    vi.mocked(fetchAgencyDashboard).mockRejectedValueOnce(new Error('Unavailable'));
    renderWithProviders(<AgencyDashboardPage />);
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByText('INV-45')).toBeInTheDocument();
  });
  it('does not fetch agency data before membership succeeds', async () => {
    vi.mocked(fetchAgencyMe).mockRejectedValue(new Error('Membership unavailable'));
    renderWithProviders(<AgencyDashboardPage />);
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(fetchAgencyDashboard).not.toHaveBeenCalled();
  });
  it('renders an unsigned job and server transition objects with the packaging link', async () => {
    vi.mocked(fetchAgencyJob).mockResolvedValue({job:{id:'J',jobNumber:'INS-1',status:'REQUESTED',kind:'INITIAL',scheduledFor:null,inspectionPoint:null,report:null},requirement:{orderNumber:'ORD-1',sellerName:'Acme',level:'MANDATORY'},checklist:[],conflictCheck:{agencyProblems:[]},me:{role:'COORDINATOR',isNamedInspector:false,allowedTransitions:[{to:'ACCEPTED',requiresReason:false}]},eligibleInspectors:[]});
    renderWithProviders(<AgencyJobPage />);
    expect(await screen.findByRole('link',{name:'Packaging & label check'})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:/Accept/})).toBeInTheDocument();
  });
});
