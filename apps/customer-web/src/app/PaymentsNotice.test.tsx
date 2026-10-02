/**
 * The storefront's payments notice (JOURNEY-065): shown only when the server
 * says payments are degraded, and silent when the check itself fails.
 */
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentsNotice } from './PaymentsNotice';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PaymentsNotice', () => {
  it('warns shoppers while payments are degraded', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ paymentsDegraded: true }));
    renderWithProviders(<PaymentsNotice />);
    expect(await screen.findByText(/card payments/i)).toBeTruthy();
  });

  it('says nothing when payments are fine', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ paymentsDegraded: false }));
    renderWithProviders(<PaymentsNotice />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says nothing when the check itself fails', async () => {
    fetchMock.mockResolvedValue(errorResponse(503, 'SERVICE_UNAVAILABLE', 'Down.'));
    renderWithProviders(<PaymentsNotice />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
