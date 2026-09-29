/**
 * "How assurance works" (checklist Master row 7): it describes the settings the
 * API reports, says when a protection is not in use, and always states its
 * limits.
 */
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssurancePage } from './AssurancePage';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

function facts(overrides: Record<string, unknown> = {}) {
  return {
    verifiedSuppliers: 8,
    inspection: { inUse: false, mandatoryRules: 0 },
    returns: { windowDays: 14, replacementEnabled: false },
    claims: { claimWindowDays: 30, sellerResponseHours: 72, decisionHours: 168, appealWindowDays: 7 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AssurancePage', () => {
  it('states the configured numbers', async () => {
    fetchMock.mockResolvedValue(jsonResponse(facts()));
    renderWithProviders(<AssurancePage />);

    expect(await screen.findByText(/^8 suppliers sell here\./)).toBeInTheDocument();
    expect(screen.getByText(/within 14 days of delivery\. An accepted return is refunded\./)).toBeInTheDocument();
    expect(screen.getByText('You have 30 days after delivery to raise a claim about an order.')).toBeInTheDocument();
    expect(screen.getByText('The seller has 72 hours to respond.')).toBeInTheDocument();
    expect(screen.getByText(/aims to decide within 7 days\./)).toBeInTheDocument();
    expect(screen.getByText('You can appeal the decision within 7 days.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support');
  });

  it('says inspection is not in use rather than implying it', async () => {
    fetchMock.mockResolvedValue(jsonResponse(facts()));
    renderWithProviders(<AssurancePage />);
    expect(await screen.findByText(/is not required on any order at the moment/)).toBeInTheDocument();
    expect(screen.queryByText(/cannot be dispatched until the inspection passes/)).not.toBeInTheDocument();
  });

  it('explains the dispatch gate when inspection rules are in force', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(facts({ inspection: { inUse: true, mandatoryRules: 2 }, returns: { windowDays: 14, replacementEnabled: true } })),
    );
    renderWithProviders(<AssurancePage />);
    expect(await screen.findByText(/cannot be dispatched until the inspection passes/)).toBeInTheDocument();
    expect(screen.getByText(/refunded or replaced/)).toBeInTheDocument();
  });

  it('says returns are not offered when the window is zero', async () => {
    fetchMock.mockResolvedValue(jsonResponse(facts({ returns: { windowDays: 0, replacementEnabled: false } })));
    renderWithProviders(<AssurancePage />);
    expect(await screen.findByText('Returns are not offered at the moment.')).toBeInTheDocument();
  });

  it('always lists what is not covered', async () => {
    fetchMock.mockResolvedValue(jsonResponse(facts()));
    renderWithProviders(<AssurancePage />);
    const limits = await screen.findByRole('region', { name: 'What this does not cover' });
    expect(limits).toHaveTextContent('delivery dates are not guaranteed');
    expect(limits).toHaveTextContent('It is not an insurance policy');
  });

  it('offers a retry when the facts cannot be read, and makes no claim', async () => {
    fetchMock.mockResolvedValue(errorResponse(503, 'SERVICE_UNAVAILABLE', 'Unavailable.'));
    renderWithProviders(<AssurancePage />);
    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
    expect(screen.queryByText(/suppliers sell here/)).not.toBeInTheDocument();
  });
});
