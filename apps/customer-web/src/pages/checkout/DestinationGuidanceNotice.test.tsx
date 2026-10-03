import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DestinationGuidanceNotice } from './DestinationGuidanceNotice';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();
const A = '01HZZZZZZZZZZZZZZZZZZZZZZA';
const B = '01HZZZZZZZZZZZZZZZZZZZZZZB';
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

describe('checkout destination guidance', () => {
  it('shows importer instructions and required documents for the delivery country and basket', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ country: 'DE', complianceNotes: 'Name an EU importer of record.', documentRequirements: [{ reason: 'Medical devices need proof.', requiredDocuments: ['CE certificate', 'Import licence'] }] }));
    renderWithProviders(<DestinationGuidanceNotice country="DE" productIds={[B, A, B]} />);
    expect(await screen.findByRole('heading', { name: /DE/ })).toBeInTheDocument();
    expect(screen.getByText('Name an EU importer of record.')).toBeInTheDocument();
    expect(screen.getByText('Medical devices need proof.')).toBeInTheDocument();
    expect(screen.getByText('CE certificate')).toBeInTheDocument();
    expect(screen.getByText('Import licence')).toBeInTheDocument();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/catalog/destination-guidance?country=DE&products=' + encodeURIComponent(`${A},${B}`));
  });
  it('renders nothing when the operator configured nothing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ country: 'US', complianceNotes: null, documentRequirements: [] }));
    const { container } = renderWithProviders(<DestinationGuidanceNotice country="US" productIds={[A]} />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    expect(container.querySelector('section')).toBeNull();
  });
  it('does not ask without a destination or basket', () => {
    renderWithProviders(<><DestinationGuidanceNotice country={null} productIds={[A]} /><DestinationGuidanceNotice country="DE" productIds={[]} /></>);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
