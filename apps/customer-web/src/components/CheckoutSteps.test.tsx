/**
 * The progress indicator, tested for the one thing it can get dangerously
 * wrong: **saying a step is done when it is not.**
 *
 * A checkout progress bar is the easiest place in a storefront to tell a lie
 * by accident. Ticking "Payment" because the customer reached the payment page
 * is a single-character mistake, and it contradicts everything the payment page
 * itself is careful to say. These tests pin the states each page asks for, and
 * pin the markers those states produce.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CheckoutSteps } from './CheckoutSteps';
import {
  CART_STEPS,
  checkoutSteps,
  confirmationSteps,
  paymentSteps,
} from '@/lib/checkout-steps';

/** The list item for a step, found by its visible label. */
function step(label: string): HTMLElement {
  const item = screen.getByText(label, { exact: false }).closest('li');
  if (item === null) throw new Error(`No step list item for "${label}"`);
  return item;
}

describe('checkout step states', () => {
  it('marks nothing after the cart when the customer is still in the cart', () => {
    expect(CART_STEPS).toEqual({
      cart: 'current',
      address: 'upcoming',
      payment: 'upcoming',
      confirmation: 'upcoming',
    });
  });

  it('holds the address step open until an address is actually chosen', () => {
    expect(checkoutSteps(false).address).toBe('current');
    expect(checkoutSteps(true).address).toBe('complete');
  });

  it('never marks payment complete from the checkout page, which takes no money', () => {
    expect(checkoutSteps(true).payment).toBe('upcoming');
  });

  it('marks payment complete only when the backend says the order is paid', () => {
    // Being *on* the payment page is not evidence of payment.
    expect(paymentSteps(false).payment).toBe('current');
    expect(paymentSteps(true).payment).toBe('complete');
  });

  it('shows an unpaid placed order as waiting, not as done', () => {
    // A payment-link order is placed and unpaid, which is neither a tick nor
    // an untouched step.
    expect(confirmationSteps(false).payment).toBe('waiting');
    expect(confirmationSteps(true).payment).toBe('complete');
    expect(confirmationSteps(false).confirmation).toBe('current');
  });
});

describe('CheckoutSteps', () => {
  it('announces each step’s state in words, not only in colour', () => {
    render(<CheckoutSteps states={paymentSteps(false)} />);

    expect(within(step('Cart')).getByText(': completed')).toBeInTheDocument();
    expect(within(step('Payment')).getByText(': current step')).toBeInTheDocument();
    expect(within(step('Confirmation')).getByText(': not started')).toBeInTheDocument();
  });

  it('marks the current step with aria-current so it is findable, once', () => {
    render(<CheckoutSteps states={checkoutSteps(false)} />);

    const current = screen.getAllByRole('listitem').filter(
      (item) => item.getAttribute('aria-current') === 'step',
    );

    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Address');
  });

  it('does not describe payment as completed while it is still being taken', () => {
    render(<CheckoutSteps states={paymentSteps(false)} />);

    expect(within(step('Payment')).queryByText(': completed')).not.toBeInTheDocument();
  });

  it('carries the page’s own caption for a step that is waiting', () => {
    render(
      <CheckoutSteps
        states={confirmationSteps(false)}
        notes={{ payment: 'Not paid yet' }}
      />,
    );

    expect(within(step('Payment')).getByText(': waiting')).toBeInTheDocument();
    expect(screen.getByText('Not paid yet')).toBeInTheDocument();
  });
});
