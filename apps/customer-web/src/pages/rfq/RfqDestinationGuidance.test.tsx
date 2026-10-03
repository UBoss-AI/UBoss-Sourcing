import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RfqDestinationGuidance } from './RfqDestinationGuidance';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import { formatMoneyMinor } from '@/lib/format';

const fetchMock = vi.fn();
const guidance = (country: string, categoryId: string | null, complianceNotes: string | null = null) => ({ country, categoryId, complianceNotes, notes: [], blockedReason: null });
function DraftFields(): React.JSX.Element {
  const [country, setCountry] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [title, setTitle] = useState('Unsaved title');
  return <><label>Draft title<input value={title} onChange={event => { setTitle(event.target.value); }} /></label>
    <button onClick={() => { setCountry('IN'); }}>India</button><button onClick={() => { setCountry('BR'); }}>Brazil</button>
    <button onClick={() => { setCategory('category-a'); }}>Category A</button><button onClick={() => { setCategory('category-b'); }}>Category B</button>
    <RfqDestinationGuidance country={country} categoryId={category} /></>;
}
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

describe('inline RFQ destination guidance', () => {
  it('keeps a threshold qualified when browser currency enumeration throws', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'supportedValuesOf');
    Object.defineProperty(Intl, 'supportedValuesOf', { configurable: true, writable: true, value: () => { throw new RangeError('Currency enumeration unavailable'); } });
    try {
      fetchMock.mockResolvedValue(jsonResponse({ ...guidance('IN', 'cat'), notes: [
        { effect: 'BLOCK', reason: 'Conditional enumeration restriction', requiredDocuments: [], categoryName: 'Equipment', labelText: null, minOrderValueMinor: '123', thresholdCurrency: 'USD' },
      ] }));
      renderWithProviders(<RfqDestinationGuidance country="IN" categoryId="cat" />);
      expect(await screen.findByText('Conditional enumeration restriction')).toBeVisible();
      expect(screen.getByText('This rule depends on an order-value threshold, but its currency or amount cannot be interpreted. Confirm the configured threshold with the marketplace operator.')).toBeVisible();
      expect(screen.queryByText(/This category is blocked for this destination/)).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(Intl, 'supportedValuesOf');
      else Object.defineProperty(Intl, 'supportedValuesOf', descriptor);
    }
  });
  it('keeps a threshold qualified when the browser cannot enumerate currencies', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'supportedValuesOf');
    Object.defineProperty(Intl, 'supportedValuesOf', { configurable: true, writable: true, value: undefined });
    try {
      fetchMock.mockResolvedValue(jsonResponse({ ...guidance('IN', 'cat'), notes: [
        { effect: 'BLOCK', reason: 'Conditional browser restriction', requiredDocuments: [], categoryName: 'Equipment', labelText: null, minOrderValueMinor: '123', thresholdCurrency: 'USD' },
      ] }));
      renderWithProviders(<RfqDestinationGuidance country="IN" categoryId="cat" />);
      expect(await screen.findByText('Conditional browser restriction')).toBeVisible();
      expect(screen.getByText('This rule depends on an order-value threshold, but its currency or amount cannot be interpreted. Confirm the configured threshold with the marketplace operator.')).toBeVisible();
      expect(screen.queryByText(/This category is blocked for this destination/)).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(Intl, 'supportedValuesOf');
      else Object.defineProperty(Intl, 'supportedValuesOf', descriptor);
    }
  });
  it('does not show prior-country prose after the next country fails', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.includes('country=BR') ? errorResponse(503, 'UNAVAILABLE', 'Unavailable') : jsonResponse(guidance('IN', null, 'India only instructions'))));
    renderWithProviders(<DraftFields />);
    const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'India' }));
    expect(await screen.findByText('India only instructions')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Brazil' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByText('India only instructions')).not.toBeInTheDocument();
  });
  it.each([null, {}, { ...guidance('IN', null), notes: [null] }, guidance('BR', null)])('makes a malformed or mismatched response retryable %#', async response => {
    fetchMock.mockResolvedValue(jsonResponse(response));
    renderWithProviders(<RfqDestinationGuidance country="IN" categoryId={null} />);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByText('No guidance is configured for this destination and category. This does not confirm compliance.')).not.toBeInTheDocument();
  });
  it('does not read before a destination and responds to unsaved country/category without writes or stale prior prose', async () => {
    let finishBrazil: (value: Response) => void = () => {};
    let finishCategory: (value: Response) => void = () => {};
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('country=BR')) return new Promise<Response>(resolve => { finishBrazil = resolve; });
      if (url.includes('categoryId=category-b')) return new Promise<Response>(resolve => { finishCategory = resolve; });
      return Promise.resolve(jsonResponse(guidance('IN', url.includes('categoryId=category-a') ? 'category-a' : null, 'India instructions')));
    });
    renderWithProviders(<DraftFields />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Choose a destination to see configured importer, labeling and document guidance.')).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'India' }));
    expect(await screen.findByText('India instructions')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Category A' }));
    await waitFor(() => { expect(fetchMock.mock.calls.some(([url]) => String(url).includes('categoryId=category-a'))).toBe(true); });
    expect(await screen.findByText('India instructions')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Category B' }));
    expect(screen.queryByText('India instructions')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading guidance');
    await waitFor(() => { expect(fetchMock.mock.calls.some(([url]) => String(url).includes('categoryId=category-b'))).toBe(true); });
    finishCategory(jsonResponse(guidance('IN', 'category-b', 'Category B instructions')));
    expect(await screen.findByText('Category B instructions')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Brazil' }));
    expect(screen.queryByText('Category B instructions')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading guidance');
    await waitFor(() => { expect(fetchMock.mock.calls.some(([url]) => String(url).includes('country=BR'))).toBe(true); });
    finishBrazil(jsonResponse(guidance('BR', 'category-b', 'Brazil importer instructions')));
    expect(await screen.findByText('Brazil importer instructions')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Draft title' })).toHaveValue('Unsaved title');
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'POST' && (init as RequestInit | undefined)?.method !== 'PUT')).toBe(true);
  });
  it('offers accessible explicit retry and an honest empty state', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(503, 'UNAVAILABLE', 'Unavailable')).mockResolvedValue(jsonResponse(guidance('IN', null)));
    renderWithProviders(<RfqDestinationGuidance country="IN" categoryId={null} />);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No guidance is configured for this destination and category. This does not confirm compliance.')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('renders literal published label/document prose and qualifies exact monetary thresholds without asserting an unconditional block', async () => {
    const minor = '9007199254740993123';
    fetchMock.mockResolvedValue(jsonResponse({ ...guidance('IN', 'cat', '<script>Importer instructions</script>'), notes: [
      { effect: 'BLOCK', reason: 'Conditional restriction', requiredDocuments: ['Import licence'], categoryName: 'Equipment', labelText: '<script>Local label</script>', minOrderValueMinor: minor, thresholdCurrency: 'USD' },
    ] }));
    const { container } = renderWithProviders(<RfqDestinationGuidance country="IN" categoryId="cat" />);
    expect(await screen.findByText('<script>Importer instructions</script>')).toBeVisible();
    expect(screen.getByText('Required label: <script>Local label</script>')).toBeVisible();
    expect(screen.getByText('Import licence')).toBeVisible();
    expect(screen.getByText('Applies only when the order value is at least ' + formatMoneyMinor(minor, 'USD') + '. The RFQ target unit price is not an order value.')).toBeVisible();
    expect(screen.queryByText(/This category is blocked for this destination/)).not.toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
  });
  it.each([null, 'not-currency', 'ZZZ'])('keeps invalid threshold currency qualified without interpreting it %s', async thresholdCurrency => {
    fetchMock.mockResolvedValue(jsonResponse({ ...guidance('IN', 'cat'), notes: [
      { effect: 'BLOCK', reason: 'Qualified restriction', requiredDocuments: [], categoryName: 'Equipment', labelText: null, minOrderValueMinor: '123', thresholdCurrency },
    ] }));
    renderWithProviders(<RfqDestinationGuidance country="IN" categoryId="cat" />);
    expect(await screen.findByText('Qualified restriction')).toBeVisible();
    expect(screen.getByText('This rule depends on an order-value threshold, but its currency or amount cannot be interpreted. Confirm the configured threshold with the marketplace operator.')).toBeVisible();
    expect(screen.queryByText(/This category is blocked for this destination/)).not.toBeInTheDocument();
  });
});