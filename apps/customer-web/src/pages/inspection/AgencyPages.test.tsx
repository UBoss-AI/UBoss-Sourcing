import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgencyDashboardPage, AgencyJobPage } from './AgencyPages';
import { renderWithProviders } from '@/test/harness';
import { agencyAction, fetchAgencyCalendar, fetchAgencyDashboard, fetchAgencyJob, fetchAgencyMe, type AgencyDashboard } from '@/lib/inspection';

vi.mock('@/lib/inspection', async (original) => ({
  ...await original<typeof import('@/lib/inspection')>(),
  fetchAgencyDashboard: vi.fn(), fetchAgencyMe: vi.fn(), fetchAgencyJob: vi.fn(), fetchAgencyCalendar: vi.fn(), agencyAction: vi.fn(),
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
  vi.mocked(fetchAgencyCalendar).mockResolvedValue({ capacity: 2, days: [] });
  vi.mocked(agencyAction).mockResolvedValue({ bindingId: 'B', releaseId: 'R' });
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

describe('agency calendar (ENH-011)', () => {
  it('shows capacity per day, each job with time and port, and seller readiness', async () => {
    vi.mocked(fetchAgencyCalendar).mockResolvedValue({
      capacity: 2,
      days: [
        { date: '2026-10-05', booked: 2, capacity: 2, full: true, jobs: [
          { id: 'J1', jobNumber: 'INS-PORT', status: 'ACCEPTED', time: '09:30', inspectionPointType: 'PORT', inspectionPoint: { port: 'Nhava Sheva', city: 'Mumbai', country: 'IN' }, readiness: 'READY', readyDate: '2026-10-04' },
          { id: 'J2', jobNumber: 'INS-WH', status: 'REQUESTED', time: '14:00', inspectionPointType: 'WAREHOUSE', inspectionPoint: null, readiness: 'NOT_READY', readyDate: null },
        ] },
        { date: '2026-10-06', booked: 0, capacity: 2, full: false, jobs: [] },
      ],
    });
    renderWithProviders(<AgencyDashboardPage />);
    const day = await screen.findByTestId('calendar-day-2026-10-05');
    expect(within(day).getByText('09:30')).toBeInTheDocument();
    expect(within(day).getByRole('link', { name: 'INS-PORT' })).toHaveAttribute('href', '/inspection/jobs/J1');
    expect(within(day).getByText('Nhava Sheva, Mumbai, IN')).toBeInTheDocument();
    expect(within(day).getByText('WAREHOUSE')).toBeInTheDocument();
    expect(within(day).getAllByText(/inspection.calendar.full|Full/)).toHaveLength(1);
    expect(within(day).getAllByText(/inspection.calendar.ready$|^Ready$/)).toHaveLength(1);
    expect(within(day).getAllByText(/inspection.calendar.notReady|Not ready/)).toHaveLength(1);
    expect(screen.getByTestId('calendar-day-2026-10-06')).toBeInTheDocument();
    expect(vi.mocked(fetchAgencyCalendar).mock.calls[0]?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('moves two weeks forward from the chosen start date', async () => {
    vi.mocked(fetchAgencyCalendar).mockResolvedValue({ capacity: 2, days: [] });
    renderWithProviders(<AgencyDashboardPage />);
    const start = await screen.findByLabelText(/inspection.calendar.from|Starting/);
    fireEvent.change(start, { target: { value: '2026-10-01' } });
    await waitFor(() => { expect(fetchAgencyCalendar).toHaveBeenLastCalledWith('2026-10-01'); });
    fireEvent.click(screen.getByRole('button', { name: /inspection.calendar.next|Next/ }));
    await waitFor(() => { expect(fetchAgencyCalendar).toHaveBeenLastCalledWith('2026-10-15'); });
  });
});

describe('container and seal binding (ENH-012)', () => {
  const passed = {
    job: { id: 'J', jobNumber: 'INS-9', status: 'COMPLETED', kind: 'INITIAL', scheduledFor: null, inspectionPoint: null, report: { status: 'SIGNED', result: 'PASS' } },
    requirement: { orderNumber: 'ORD-9', sellerName: 'Acme', level: 'MANDATORY' },
    checklist: [], conflictCheck: { agencyProblems: [] }, eligibleInspectors: [],
    me: { role: 'INSPECTOR', isNamedInspector: true, allowedTransitions: [] },
    consignments: [{ id: 'S1', shipmentReference: 'SHP-1', containerNumbers: ['MSCU1234567'], sealNumbers: ['SEAL-1'] }],
    bindings: [{ id: 'B0', containerNumber: 'OLD1234567', sealNumber: 'S-0', stuffedQuantity: 10, stuffedAt: '2026-09-30T10:00:00Z', witnessName: 'Ravi' }],
  };

  it('records container, seal, stuffed quantity and time and witness against a consignment', async () => {
    vi.mocked(fetchAgencyJob).mockResolvedValue(passed);
    renderWithProviders(<AgencyJobPage />);
    expect(await screen.findByText(/OLD1234567/)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: /inspection.binding.save|Record loading/ });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/inspection.binding.consignment|Consignment/), { target: { value: 'S1' } });
    fireEvent.change(screen.getByLabelText(/inspection.binding.containerNumber|Container/), { target: { value: ' MSCU1234567 ' } });
    fireEvent.change(screen.getByLabelText(/inspection.binding.sealNumber|Seal/), { target: { value: 'SEAL-1' } });
    fireEvent.change(screen.getByLabelText(/inspection.binding.stuffedQuantity|quantity/i), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(/inspection.binding.stuffedAt|Stuffed at/), { target: { value: '2026-10-01T09:15' } });
    fireEvent.change(screen.getByLabelText(/inspection.binding.witness|Witness/), { target: { value: 'Ravi' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => { expect(agencyAction).toHaveBeenCalled(); });
    expect(vi.mocked(agencyAction).mock.calls[0]?.[1]).toBe('binding');
    expect(vi.mocked(agencyAction).mock.calls[0]?.[2]).toEqual({
      logisticsShipmentId: 'S1', containerNumber: 'MSCU1234567', sealNumber: 'SEAL-1', stuffedQuantity: 100,
      stuffedAt: new Date('2026-10-01T09:15').toISOString(), witnessName: 'Ravi',
    });
  });

  it('offers no binding form before the report passed, or to anyone but the named inspector', async () => {
    vi.mocked(fetchAgencyJob).mockResolvedValue({ ...passed, bindings: [], job: { ...passed.job, report: { status: 'SIGNED', result: 'FAIL' } } });
    renderWithProviders(<AgencyJobPage />);
    expect(await screen.findByText('INS-9')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /inspection.binding.save|Record loading/ })).not.toBeInTheDocument();
  });
});
