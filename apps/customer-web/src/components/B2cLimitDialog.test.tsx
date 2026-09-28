/**
 * The over-limit dialog: the message and the one next step that fits who is
 * asking. Nothing changes the account or trims a quantity without a press.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { B2cLimitDialog } from './B2cLimitDialog';
import type { CompanyContextOption } from '@/auth/session-context';
import { makeSession, renderWithProviders } from '@/test/harness';

const approved: CompanyContextOption = {
  companyId: 'C1',
  companyName: 'Acme Polska',
  companyStatus: 'APPROVED',
  role: 'OWNER',
  applicationReference: 'BC-1',
};

function open(session = makeSession(), props: Partial<Parameters<typeof B2cLimitDialog>[0]> = {}) {
  const onReduce = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <B2cLimitDialog isOpen limit={100} reduceTo={100} onReduce={onReduce} onClose={onClose} {...props} />,
    { session },
  );
  return { onReduce, onClose };
}

describe('B2cLimitDialog', () => {
  it('tells an individual the limit and offers to create a company account', () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Individual purchase limit' });
    expect(dialog).toHaveAccessibleDescription(
      'Individual buyers can order up to 100 units of this product. To order a larger quantity, switch to an approved Company account.',
    );
    expect(screen.getByRole('link', { name: 'Create Company Account' })).toHaveAttribute('href', '/register/company');
    expect(screen.queryByRole('button', { name: /Switch to/ })).not.toBeInTheDocument();
  });

  it('offers a guest sign-in as a company, registration and a reduction', () => {
    open(makeSession({ user: null, isCustomer: false }));
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'Individual purchases are limited to 100 units. Sign in with an approved Company account to order a larger quantity.',
    );
    expect(screen.getByRole('link', { name: 'Sign in as Company' })).toHaveAttribute('href', '/login?buyerType=company');
    expect(screen.getByRole('link', { name: 'Create Company Account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reduce the quantity to 100 units' })).toBeInTheDocument();
  });

  it('switches to an approved company only when the buyer presses it', async () => {
    const session = makeSession({ companies: [approved] });
    const { onClose } = open(session);
    expect(session.switchBuyerContext).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Acme Polska' }));
    await waitFor(() => {
      expect(session.switchBuyerContext).toHaveBeenCalledWith({ kind: 'COMPANY', companyId: 'C1' });
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('sends somebody whose company is still being checked to its verification status', () => {
    open(makeSession({ companies: [{ ...approved, companyStatus: 'UNDER_REVIEW' }] }));
    expect(screen.getByRole('link', { name: 'View the verification status of Acme Polska' })).toHaveAttribute(
      'href',
      '/account/companies/C1',
    );
    expect(screen.queryByRole('button', { name: /Switch to/ })).not.toBeInTheDocument();
  });

  it('explains that a company not yet approved is still held to the limit', () => {
    open(
      makeSession({
        buyerContext: { kind: 'COMPANY', ...approved, companyStatus: 'SUSPENDED' },
        companies: [{ ...approved, companyStatus: 'SUSPENDED' }],
      }),
    );
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'Acme Polska is not approved for company purchasing yet, so the individual limit of 100 units applies until it is.',
    );
  });

  it('reduces and cancels only on the matching press', () => {
    const { onReduce, onClose } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Reduce the quantity to 100 units' }));
    expect(onReduce).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('hides "Reduce" when the basket already holds the whole limit, and says what it holds', () => {
    open(makeSession(), { reduceTo: null, alreadyInBasket: 100 });
    expect(screen.queryByRole('button', { name: /Reduce/ })).not.toBeInTheDocument();
    expect(screen.getByText('Your basket already holds 100 units of this product.')).toBeInTheDocument();
  });
});
