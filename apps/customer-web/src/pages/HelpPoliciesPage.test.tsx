/**
 * `/legal` (checklist Master row 9): every published document links to its
 * text, what is not published is named, and help is one press away.
 */
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpPoliciesPage } from './HelpPoliciesPage';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HelpPoliciesPage', () => {
  it('links every document in force and names those not published', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        documents: [
          { kind: 'PLATFORM_TERMS', id: '01TERMS0000000000000000000', title: 'Terms', version: 'v3', effectiveAt: '2026-09-01T00:00:00.000Z', isFallback: false },
          { kind: 'RETURNS_POLICY', id: '01RETURNS00000000000000000', title: 'Returns', version: '2026-09', effectiveAt: '2026-09-01T00:00:00.000Z', isFallback: true },
        ],
      }),
    );
    renderWithProviders(<HelpPoliciesPage />);

    expect(await screen.findByRole('link', { name: 'Terms and Conditions' })).toHaveAttribute('href', '/legal/documents/01TERMS0000000000000000000');
    expect(screen.getByRole('link', { name: 'Returns policy' })).toHaveAttribute('href', '/legal/documents/01RETURNS00000000000000000');
    expect(screen.getByText(/Not yet published in your language/)).toBeInTheDocument();
    expect(screen.getByText(/Not published yet: Seller terms, Privacy policy, Buyer protection policy, Inspection policy, Prohibited products/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/legal/in-force');
  });

  it('shows the operator’s own policy links, opening in a new tab', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ documents: [] }));
    renderWithProviders(<HelpPoliciesPage />, {
      config: { ...FALLBACK_CONFIG, business: { ...FALLBACK_CONFIG.business, policyLinks: { Cookies: 'https://example.com/cookies' } } },
    });

    const link = await screen.findByRole('link', { name: /Cookies/ });
    expect(link).toHaveAttribute('href', 'https://example.com/cookies');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps help reachable when the documents cannot be read', async () => {
    fetchMock.mockResolvedValue(errorResponse(503, 'SERVICE_UNAVAILABLE', 'Unavailable.'));
    renderWithProviders(<HelpPoliciesPage />);
    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contact support' })).toBeInTheDocument();
  });
});
