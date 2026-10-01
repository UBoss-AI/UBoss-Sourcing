/**
 * Trade compliance in the admin panel (JOURNEY-046, 049): insurance settings
 * sent as whole basis points, a trade rule saved with its party and
 * restriction, an HS code verified with a correction against the code the
 * reviewer saw, and a dispatch hold overridden with a written reason on the
 * order page. Read-only without the write permissions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { CompliancePanel } from '../order/CompliancePanel';
import { TradeCompliancePage } from './TradeCompliancePage';

const fetchMock = vi.fn();
const tr = (key: string, options?: Record<string, unknown>): string =>
  (i18n.t as unknown as (k: string, o?: Record<string, unknown>) => string)(key, options);
const label = (key: string): RegExp => new RegExp(`^${tr(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*\\*\\s*\\(required\\))?$`);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderPage(page: React.JSX.Element, permissions: string[]): void {
  const session = {
    user: { id: 'u1', email: 'owner@example.test' },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    can: (permission: string) => permissions.includes(permission),
    canAny: (...wanted: string[]) => wanted.some((permission) => permissions.includes(permission)),
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={session}>
            <MemoryRouter>{page}</MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const RULE = {
  id: 'r1',
  name: 'EU conformity',
  destinationCountry: 'DE',
  category: { id: 'c1', name: 'Masks' },
  hsPrefix: '6307',
  restriction: 'RESTRICTED',
  requiredDocumentKind: 'CATEGORY:CE',
  requiredDocumentName: 'EU declaration',
  responsibleParty: 'SELLER',
  requiresHsVerification: true,
  documentBuyerVisible: true,
  note: null,
  isActive: true,
};

function serve(): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/admin/logistics/trade-settings')) {
      return Promise.resolve(json({ settings: { insuranceBasisPoints: 0, maxInsuredBasisPoints: 11000, insuranceOffered: false } }));
    }
    if (url.includes('/admin/trade-rules')) return Promise.resolve(method === 'GET' ? json({ rules: [RULE] }) : json({ rule: RULE }, 201));
    if (url.includes('/admin/categories')) {
      return Promise.resolve(json({ categories: [{ id: 'c1', parentId: null, name: 'Masks', slug: 'masks', depth: 0, sortOrder: 0, isActive: true, children: [] }] }));
    }
    if (url.includes('/admin/hs-verifications')) {
      return Promise.resolve(
        json({
          reviews: [
            { offerId: 'o1', sellerName: 'Omega', sellerSku: 'M-50', productName: 'Masks', declaredCode: '63079090', countryOfOrigin: 'IN', state: 'DECLARED', verifiedCode: null, note: null, verifiedAt: null },
          ],
          review: {},
        }),
      );
    }
    if (url.includes('/compliance-override')) return Promise.resolve(json({ sellerOrder: {} }));
    if (url.includes('/admin/orders/ord1/compliance')) {
      return Promise.resolve(
        json({
          sellerOrders: [
            {
              sellerOrderGroupId: 'g1',
              sellerOrderNumber: 'SO-1',
              sellerName: 'Omega',
              status: 'PROCESSING',
              verdict: {
                destination: 'DE',
                items: [{ ruleId: 'r1', ruleName: 'EU conformity', restriction: 'RESTRICTED', responsibleParty: 'SELLER', documentName: 'EU declaration', status: 'MISSING' }],
                holds: [{ key: 'k1', code: 'DOCUMENT_MISSING', ruleName: 'EU conformity', responsibleParty: 'SELLER', sku: null, covered: false }],
                open: false,
                overridden: false,
              },
              override: null,
            },
          ],
        }),
      );
    }
    return Promise.resolve(json({}));
  });
}

const sent = (method: string, fragment: string): [string, RequestInit] | undefined =>
  fetchMock.mock.calls.find(
    ([url, init]) => (init as RequestInit | undefined)?.method === method && String(url).includes(fragment),
  ) as [string, RequestInit] | undefined;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  serve();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ALL = ['settings.read', 'settings.write', 'logistics.read', 'logistics.write', 'product.read', 'product.publish'];

describe('TradeCompliancePage', () => {
  it('saves insurance settings as whole basis points', async () => {
    renderPage(<TradeCompliancePage />, ALL);
    const rate = await screen.findByLabelText(label('tradeCompliance.insurance.rate'));
    fireEvent.change(rate, { target: { value: '35' } });
    fireEvent.click(screen.getAllByRole('button', { name: tr('tradeCompliance.save') })[0] as HTMLElement);
    await waitFor(() => {
      expect(sent('PUT', '/admin/logistics/trade-settings')).toBeDefined();
    });
    const [, init] = sent('PUT', '/admin/logistics/trade-settings') as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ insuranceBasisPoints: 35, maxInsuredBasisPoints: 11000 });
  });

  it('lists rules and saves a new one with its party and restriction', async () => {
    renderPage(<TradeCompliancePage />, ALL);
    expect(await screen.findByText('EU conformity')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: tr('tradeCompliance.rules.add') }));
    fireEvent.change(screen.getByLabelText(label('tradeCompliance.rules.name')), { target: { value: 'Import licence' } });
    fireEvent.change(screen.getByLabelText(label('tradeCompliance.rules.destination')), { target: { value: 'de' } });
    fireEvent.change(screen.getByLabelText(label('tradeCompliance.rules.documentKind')), { target: { value: 'import_licence' } });
    fireEvent.change(screen.getByLabelText(label('tradeCompliance.rules.party')), { target: { value: 'BUYER' } });
    fireEvent.submit(screen.getByRole('form', { name: tr('tradeCompliance.rules.add') }));
    await waitFor(() => {
      expect(sent('POST', '/admin/trade-rules')).toBeDefined();
    });
    const [, init] = sent('POST', '/admin/trade-rules') as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      name: 'Import licence',
      destinationCountry: 'DE',
      requiredDocumentKind: 'IMPORT_LICENCE',
      responsibleParty: 'BUYER',
      restriction: 'NONE',
    });
  });

  it('verifies an HS code with a correction, naming the code the reviewer saw', async () => {
    renderPage(<TradeCompliancePage />, ALL);
    await screen.findByTestId('hs-o1');
    fireEvent.change(screen.getByLabelText(label('tradeCompliance.hs.corrected')), { target: { value: '63079098' } });
    fireEvent.click(screen.getByRole('button', { name: tr('tradeCompliance.hs.verify') }));
    await waitFor(() => {
      expect(sent('POST', '/admin/hs-verifications/o1/decision')).toBeDefined();
    });
    const [, init] = sent('POST', '/admin/hs-verifications/o1/decision') as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ decision: 'VERIFIED', declaredCode: '63079090', correctedCode: '63079098' });
  });

  it('is read-only without the write permissions', async () => {
    renderPage(<TradeCompliancePage />, ['settings.read', 'logistics.read', 'product.read']);
    expect(await screen.findByText('EU conformity')).toBeTruthy();
    await screen.findByTestId('hs-o1');
    expect(screen.queryByRole('button', { name: tr('tradeCompliance.rules.add') })).toBeNull();
    expect(screen.queryByRole('button', { name: tr('tradeCompliance.hs.verify') })).toBeNull();
  });
});

describe('CompliancePanel', () => {
  it('shows the hold and overrides it with a written reason', async () => {
    renderPage(<CompliancePanel orderId="ord1" />, ['order.read', 'logistics.write']);
    const row = await screen.findByTestId('compliance-SO-1');
    expect(row.textContent).toContain('EU declaration');
    fireEvent.change(screen.getByLabelText(label('orderCompliance.reason')), {
      target: { value: 'Broker confirmed the classification in writing.' },
    });
    fireEvent.click(screen.getByRole('button', { name: tr('orderCompliance.override') }));
    await waitFor(() => {
      expect(sent('POST', '/admin/seller-orders/g1/compliance-override')).toBeDefined();
    });
    const [, init] = sent('POST', '/admin/seller-orders/g1/compliance-override') as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'Broker confirmed the classification in writing.' });
  });
});
