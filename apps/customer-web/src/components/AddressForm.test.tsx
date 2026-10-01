/**
 * Address validation at checkout (JOURNEY-022): a postcode in the wrong shape
 * for its country is caught before Save, in the shopper's language, and
 * nothing is sent; the right shape saves.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { AddressForm } from './AddressForm';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ addressId: '01JADDRESS000000000000001', suggestions: [] }, 201)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fill(postcode: string): void {
  fireEvent.change(screen.getByLabelText(/Contact name/), { target: { value: 'Asha Rao' } });
  fireEvent.change(screen.getByLabelText(/Contact phone/), { target: { value: '+4930123456' } });
  fireEvent.change(screen.getByLabelText(/Address line 1/), { target: { value: 'Unter den Linden 1' } });
  fireEvent.change(screen.getByLabelText(/Town or city/), { target: { value: 'Berlin' } });
  fireEvent.change(screen.getByLabelText(/^State/), { target: { value: 'Berlin' } });
  fireEvent.change(screen.getByLabelText(/Postcode/), { target: { value: postcode } });
  fireEvent.change(screen.getByLabelText(/Country code/), { target: { value: 'DE' } });
}

const posts = (): unknown[] => (fetchMock.mock.calls as [string, RequestInit | undefined][]).filter(([url, init]) => init?.method === 'POST' && url.includes('/account/addresses'));

describe('AddressForm postcode', () => {
  it('refuses a postcode in the wrong shape before anything is sent', async () => {
    renderWithProviders(<AddressForm onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill('1011');
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    expect(await screen.findByText('Enter the postcode in the format used in that country.')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('saves a postcode in the right shape', async () => {
    const onSaved = vi.fn();
    renderWithProviders(<AddressForm onSaved={onSaved} onCancel={vi.fn()} />);
    fill('10117');
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
  });
});
