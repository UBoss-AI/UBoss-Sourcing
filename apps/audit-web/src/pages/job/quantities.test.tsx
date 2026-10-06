/**
 * The quantity summary says what was tested in the server's own words, and
 * keeps the count, the tests and the lot's disposition apart.
 *
 * A sample result read as "the lot was verified" is the mistake this screen
 * exists to prevent, so the statement must never sit inside the disposition.
 */
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import type { QuantitySummary } from '@/lib/console-types';
import { sessionFor } from '@/test/session-fixture';
import { agencyJobFixture, FIXTURE_JOB_ID } from './fixtures';
import { QuantitiesSection } from './QuantitiesSection';
import type { WorkspaceMode } from './types';

const STATEMENT = '40 of 50 tested units passed; 950 units were not tested.';

const quantities: QuantitySummary = {
  unit: 'PIECE',
  scopeMethod: 'SAMPLE',
  reconciliation: { ordered: '1000', declared: '1000', verified: '1000', difference: '0', status: 'MATCHES' },
  functional: { tested: '50', conforming: '40', nonconforming: '10', untested: '950', observedNonconformingBasisPoints: 2000 },
  damaged: null,
  statement: STATEMENT,
  countingMethod: 'FULL_COUNT',
  countingNote: null,
  packaging: [{ unit: 'CARTON', contains: '12', of: 'BOX' }],
  observations: { packaging: null, labelling: null, damage: null },
  raw: {
    unit: 'PIECE',
    orderedQuantity: '1000',
    declaredQuantity: '1000',
    verifiedQuantity: '1000',
    sampledQuantity: '50',
    functionallyTestedQuantity: '50',
    testedConformingQuantity: '40',
    testedNonconformingQuantity: '10',
    damagedQuantity: null,
  },
};

const readOnly: WorkspaceMode = {
  agency: true,
  namedInspector: false,
  performing: false,
  qa: false,
  coordinator: true,
  staff: false,
};

function renderSection(): void {
  const session: SessionState = {
    stage: 'READY',
    session: sessionFor(),
    notice: null,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
    can: () => false,
    canAny: () => false,
  };
  const detail = agencyJobFixture({
    job: {
      report: {
        id: 'report-1',
        revision: 1,
        status: 'SIGNED',
        result: 'FAIL',
        summary: null,
        computation: null,
        content: null,
        contentHash: 'hash',
        integrity: 'VERIFIED',
        submittedAt: '2026-10-08T10:00:00.000Z',
        returnedAt: null,
        returnReason: null,
        signedAt: '2026-10-08T12:00:00.000Z',
        signedByName: 'Q. Reviewer',
      },
    },
    extras: { quantities },
  });

  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ToastProvider>
            <SessionContext.Provider value={session}>
              <QuantitiesSection detail={detail} jobId={FIXTURE_JOB_ID} mode={readOnly} />
            </SessionContext.Provider>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe('the quantity summary', () => {
  it('shows the server’s statement word for word, under its own label', () => {
    renderSection();

    const statement = screen.getByTestId('quantities-statement');
    expect(within(statement).getByText('What was tested')).toBeDefined();
    expect(within(statement).getByText(STATEMENT)).toBeDefined();
  });

  it('keeps the count reconciliation and the lot disposition apart', () => {
    renderSection();

    const reconciliation = screen.getByTestId('quantities-reconciliation');
    const disposition = screen.getByTestId('quantities-disposition');

    expect(within(reconciliation).getByRole('heading', { name: 'Count reconciliation' })).toBeDefined();
    expect(within(reconciliation).getByText('Matches the order')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Lot disposition' })).toBeDefined();
    expect(within(disposition).getByText('Fail')).toBeDefined();

    // The disposition is the report's result, never the tested sample.
    expect(within(disposition).queryByText(STATEMENT)).toBeNull();
    expect(within(reconciliation).queryByText('Fail')).toBeNull();
    expect(reconciliation.contains(disposition)).toBe(false);
    expect(disposition.contains(screen.getByTestId('quantities-statement'))).toBe(false);
  });

  it('offers no form to somebody who is not recording the inspection', () => {
    renderSection();

    expect(screen.queryByRole('button', { name: 'Update quantities' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Record quantities' })).toBeNull();
  });
});
