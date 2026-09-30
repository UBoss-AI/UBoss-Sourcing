import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PackagingPage } from './PackagingPage';
import { renderWithProviders } from '@/test/harness';
import { agencyAction, fetchAgencyJob, uploadAgencyEvidence } from '@/lib/inspection';

vi.mock('react-router-dom', async (original) => ({ ...await original<typeof import('react-router-dom')>(), useParams: () => ({ id: 'J' }) }));
vi.mock('@/lib/inspection', async (original) => ({ ...await original<typeof import('@/lib/inspection')>(), agencyAction: vi.fn(), fetchAgencyJob: vi.fn(), uploadAgencyEvidence: vi.fn() }));
const detail = {
  job: { jobNumber: 'INS-50', status: 'IN_PROGRESS', checks: [], evidence: [] },
  checklist: [{ code: 'PACK.CARTON_QTY', section: 'PACKAGING', label: 'Carton units', requirement: '24 units', tolerance: 'Exact' }, { code: 'PROD.FUNCTION', section: 'PRODUCT', label: 'Functional test' }],
  me: { isNamedInspector: true },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchAgencyJob).mockResolvedValue(detail);
  vi.mocked(agencyAction).mockResolvedValue({});
  vi.mocked(uploadAgencyEvidence).mockResolvedValue({});
});
describe('packaging and label checks', () => {
  it('filters the booked plan and saves an observed value and reason', async () => {
    renderWithProviders(<PackagingPage />);
    expect(await screen.findByText('24 units')).toBeInTheDocument();
    expect(screen.queryByText('Functional test')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Result'), { target: { value: 'NONCONFORM' } });
    expect(screen.getByRole('button', { name: 'Save check' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Observed value/), { target: { value: '22' } });
    fireEvent.change(screen.getByLabelText(/Observations/), { target: { value: 'Two units missing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save check' }));
    await waitFor(() => { expect(agencyAction).toHaveBeenCalledWith('J', 'checks', { itemCode: 'PACK.CARTON_QTY', outcome: 'NONCONFORM', measuredValue: '22', note: 'Two units missing' }); });
  });
  it('attaches evidence to the selected packaging check', async () => {
    renderWithProviders(<PackagingPage />);
    const input = await screen.findByLabelText(/Add timestamped evidence/);
    const file = new File(['image'], 'carton.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => { expect(uploadAgencyEvidence).toHaveBeenCalledWith('J', file, { purpose: 'PACKAGING', checkItemCode: 'PACK.CARTON_QTY', note: '' }); });
  });
  it.each([{ status: 'COMPLETED', named: true }, { status: 'IN_PROGRESS', named: false }])('shows saved findings without mutation controls for $status / named=$named', async ({ status, named }) => {
    vi.mocked(fetchAgencyJob).mockResolvedValue({ ...detail, job: { ...detail.job, status, checks: [{ itemCode: 'PACK.CARTON_QTY', outcome: 'CONFORM', measuredValue: '24', note: 'Count verified', recordedAt: 'now' }], evidence: [{ id: 'E', checkItemCode: 'PACK.CARTON_QTY', purpose: 'PACKAGING', fileName: 'carton.png' }] }, me: { isNamedInspector: named } });
    renderWithProviders(<PackagingPage />);
    expect(await screen.findByText('Count verified')).toBeInTheDocument();
    expect(screen.getByText('carton.png')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save check' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Result')).not.toBeInTheDocument();
  });
  it('keeps observations after a failed save so the inspector can retry', async () => {
    vi.mocked(agencyAction).mockRejectedValueOnce(new Error('Unavailable'));
    renderWithProviders(<PackagingPage />);
    fireEvent.change(await screen.findByLabelText('Result'), { target: { value: 'CONFORM' } });
    fireEvent.change(screen.getByLabelText(/Observations/), { target: { value: 'Scanned successfully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save check' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/Observations/)).toHaveValue('Scanned successfully');
    fireEvent.click(screen.getByRole('button', { name: 'Save check' }));
    await waitFor(() => { expect(agencyAction).toHaveBeenCalledTimes(2); });
  });
  it('handles a plan without packaging checks', async () => {
    vi.mocked(fetchAgencyJob).mockResolvedValue({ ...detail, checklist: [] });
    renderWithProviders(<PackagingPage />);
    expect(await screen.findByText('This booked plan has no packaging or label checks.')).toBeInTheDocument();
  });
});
