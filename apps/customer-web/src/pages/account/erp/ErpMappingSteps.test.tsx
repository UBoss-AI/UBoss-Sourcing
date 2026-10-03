/**
 * ENH-015: the mapping step walks a purchase order's documents one at a time,
 * with order acknowledgement and shipment notice beside order, invoice and
 * status - and says plainly that those two are optional.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MappingStep } from './ErpWizardPage';
import { MAPPING_STEPS } from './erp-labels';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type { ErpMappingEntity } from '@/lib/customer-erp';

const fields = Object.fromEntries(
  MAPPING_STEPS.map((entity) => [entity, []]),
) as unknown as Record<ErpMappingEntity, { key: string; label: string; required: boolean }[]>;

beforeEach(() => {
  // An owner's view of a connection with nothing mapped yet.
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        jsonResponse({ role: 'OWNER', connection: { id: 'c1', baseUrl: 'https://erp.example', mappings: [] } }),
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mapping steps', () => {
  it('orders the documents as a purchase order lives, acknowledgement and shipment included', () => {
    expect(MAPPING_STEPS.slice(0, 5)).toEqual([
      'ORDER',
      'ACKNOWLEDGEMENT',
      'SHIPMENT',
      'INVOICE',
      'STATUS',
    ]);
  });

  it('moves between steps and marks acknowledgement and shipment as optional', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <MappingStep connectionId="c1" platformFields={fields} onBack={() => {}} onNext={() => {}} />,
    );

    const nav = await screen.findByRole('navigation', { name: 'Mapping steps' });
    const steps = within(nav).getAllByRole('button');

    expect(steps).toHaveLength(MAPPING_STEPS.length);
    expect(steps[0]).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByText(/Optional: map this only/)).not.toBeInTheDocument();

    await user.click(within(nav).getByRole('button', { name: '2. Order acknowledgements' }));

    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(steps[0]).not.toHaveAttribute('aria-current');
    expect(screen.getByText(/Step 2 of 8: Order acknowledgements\./)).toBeInTheDocument();
    expect(screen.getByText(/Optional: map this only/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Mapping for' })).toHaveValue('ACKNOWLEDGEMENT');

    await user.click(within(nav).getByRole('button', { name: '3. Shipment notices' }));

    expect(screen.getByText(/Step 3 of 8: Shipment notices\./)).toBeInTheDocument();
  });
});
