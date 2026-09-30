import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InspectionPanel } from './InspectionPanel';
import { renderWithProviders } from '@/test/harness';
import type { InspectionView } from '@/lib/inspection';

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
});
