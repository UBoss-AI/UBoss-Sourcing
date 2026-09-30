import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InspectionPanel } from './InspectionPanel';
import { renderWithProviders } from '@/test/harness';
import type { InspectionView } from '@/lib/inspection';
import { submitCapa, uploadCorrectiveEvidence } from '@/lib/inspection';

vi.mock('@/lib/inspection', async (original) => ({ ...await original<typeof import('@/lib/inspection')>(), submitCapa: vi.fn(), uploadCorrectiveEvidence: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(submitCapa).mockResolvedValue({}); vi.mocked(uploadCorrectiveEvidence).mockResolvedValue({}); });

const view: InspectionView = {
  requirement: { id: 'R', orderNumber: 'ORD-1', sellerOrderGroupId: 'G', sellerName: 'Acme', level: 'MANDATORY', status: 'FAILED', reason: null, gate: { allowed: false, sentence: 'Shipment is blocked until the inspection passes.' } },
  jobs: [{
    id: 'J', jobNumber: 'INS-1', kind: 'INITIAL', status: 'COMPLETED', agency: { name: 'Independent QA' }, payer: 'BUYER', scheduledFor: null,
    inspectionPointType: 'SELLER_PREMISES', inspectionPoint: { label: 'Factory' }, readinessSubmittedAt: '2026-09-30T00:00:00Z', inspector: { fullName: 'Priya' },
    report: { status: 'SIGNED', result: 'FAIL', summary: null, signedAt: '2026-09-30T00:00:00Z', signedByName: 'QA Lead' },
    defects: [{ id: 'D', ncrNumber: 'NCR-1', severity: 'MAJOR', status: 'OPEN', description: 'Seal torn', correctiveAction: null }],
  }],
  releases: [],
  timeline: [{ id: 'E', kind: 'REPORT_SIGNED', actorLabel: 'Agency', summary: 'Report signed: FAIL', createdAt: '2026-09-30T00:00:00Z' }],
};

describe('the inspection panel', () => {
  it('shows the buyer the result, the NCR and that shipment is blocked, with no seller forms', () => {
    renderWithProviders(<InspectionPanel view={view} audience="BUYER" queryKey={['x']} />);
    expect(screen.getByText('FAIL')).toBeInTheDocument();
    expect(screen.getByText(/NCR-1/)).toBeInTheDocument();
    expect(screen.getByText(/blocked until the inspection passes/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /corrective action/i })).not.toBeInTheDocument();
  });

  it('offers the seller a corrective action for a major NCR', () => {
    renderWithProviders(<InspectionPanel view={view} audience="SELLER" queryKey={['x']} />);
    expect(screen.getByRole('button', { name: /send corrective action/i })).toBeDisabled();
  });
  it('requires corrective evidence before submitting the seller response', async () => {
    renderWithProviders(<InspectionPanel view={view} audience="SELLER" queryKey={['x']} />);
    fireEvent.change(screen.getByLabelText(/Your response/), { target: { value: 'Seal damaged' } });
    fireEvent.change(screen.getByLabelText(/corrective action.*taken/i), { target: { value: 'Repacked all cartons' } });
    expect(screen.getByRole('button', { name: /send corrective action/i })).toBeDisabled();
    const file=new File(['image'],'fixed.png',{type:'image/png'});
    fireEvent.change(screen.getByLabelText('Corrective evidence'),{target:{files:[file]}});
    await waitFor(()=>{ expect(screen.getByRole('button',{name:/send corrective action/i})).toBeEnabled(); });
    expect(uploadCorrectiveEvidence).toHaveBeenCalledWith('J','D',file);
    fireEvent.click(screen.getByRole('button',{name:/send corrective action/i}));
    await waitFor(()=>{ expect(submitCapa).toHaveBeenCalledWith('D',{sellerResponse:'Seal damaged',correctiveAction:'Repacked all cartons'}); });
  });
  it('keeps submission blocked when corrective evidence upload fails', async () => {
    vi.mocked(uploadCorrectiveEvidence).mockRejectedValueOnce(new Error('Unavailable'));
    renderWithProviders(<InspectionPanel view={view} audience="SELLER" queryKey={['x']} />);
    fireEvent.change(screen.getByLabelText('Corrective evidence'),{target:{files:[new File(['x'],'fixed.png')]}});
    await waitFor(()=>{ expect(uploadCorrectiveEvidence).toHaveBeenCalled(); });
    expect(screen.getByRole('button',{name:/send corrective action/i})).toBeDisabled();
    expect(submitCapa).not.toHaveBeenCalled();
  });
  it('shows linked repeat inspections and submitted corrective evidence', () => {
    const original={...view.jobs[0]!,evidence:[{id:'E',purpose:'CAPA',defectId:'D',fileName:'fixed.png'}],defects:[{...view.jobs[0]!.defects![0]!,status:'CAPA_SUBMITTED',correctiveAction:'Repacked all cartons'}]};
    renderWithProviders(<InspectionPanel view={{...view,jobs:[original,{...original,id:'J2',jobNumber:'INS-2',kind:'REINSPECTION',reinspectionOfJobId:'J',defects:[],evidence:[]}]}} audience="SELLER" queryKey={['x']} />);
    expect(screen.getByText('Original inspection: INS-1')).toBeInTheDocument();
    expect(screen.getByText('fixed.png')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:/send corrective action/i})).not.toBeInTheDocument();
  });
});
