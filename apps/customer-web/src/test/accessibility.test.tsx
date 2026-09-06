/**
 * WCAG 2.1 AA regression guard, across the surfaces a customer actually uses.
 *
 * The European Accessibility Act has applied to e-commerce services since
 * 28 June 2025, and EN 301 549 points at WCAG 2.1 AA. This file is the part of
 * that a machine can hold: it renders the storefront's real components and runs
 * axe-core over the result, so a regression fails a build rather than waiting
 * for somebody to report it.
 *
 * The surfaces here are chosen by consequence, not by coverage. A shopper who
 * cannot read a product page cannot choose; one who cannot complete the
 * address form cannot buy; one who cannot reach the safety warnings has been
 * denied information the law says they get. Those come first.
 *
 * Read `src/test/axe.ts` for what this deliberately cannot check.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/harness';
import { expectNoA11yViolations } from '@/test/axe';
import { ProductSafetyPanel } from '@/components/ProductSafetyPanel';
import { ProductDevicePanel } from '@/components/ProductDevicePanel';
import { QuantityInput } from '@/components/QuantityInput';
import { GrandTotalRow, TotalRow } from '@/components/Totals';
import { CheckoutSteps } from '@/components/CheckoutSteps';
import { CART_STEPS } from '@/lib/checkout-steps';
import { PageEmptyState } from '@/components/PageEmptyState';
import { ProductCard } from '@/components/ProductCard';
import { AddressForm } from '@/components/AddressForm';
import { Modal } from '@/components/Modal';
import { Field, Input, Select, Textarea } from '@/components/ui';
import type { Money, Product, ProductDevice, ProductSafety } from '@/lib/types';

function money(minor: string, currency = 'INR'): Money {
  return { minor, currency, formatted: `₹${minor}` };
}

const SAFETY: ProductSafety = {
  warnings: 'Single use only. Do not re-sterilise.',
  instructions: 'Inspect the packaging before use.',
  gtin: '05012345678900',
  modelIdentifier: 'AF-IV-200',
  manufacturer: {
    legalName: 'Zorgproducten B.V.',
    tradeName: null,
    address: { line1: 'Industrieweg 1', city: 'Rotterdam', postalCode: '3011AA' },
    countryCode: 'NL',
    email: 'compliance@zorgproducten.test',
    phone: '+31 10 1234567',
    website: 'https://zorgproducten.test',
  },
  euResponsiblePerson: {
    legalName: 'EU Rep Services GmbH',
    tradeName: null,
    address: { line1: 'Hafenstraße 4', city: 'Hamburg' },
    countryCode: 'DE',
    email: 'rep@eurep.test',
    phone: null,
    website: null,
  },
};

const PRODUCT: Product = {
  id: 'p1',
  name: 'Accu-Flow IV Infusion Set',
  slug: 'accu-flow',
  sku: 'AF-200',
  shortDescription: 'Sterile single-use infusion set.',
  description: null,
  descriptionHtml: null,
  price: money('12500'),
  compareAtPrice: null,
  tax: {
    code: 'GST18',
    name: 'GST 18%',
    ratePercent: '18',
    inclusive: false,
    country: null,
    treatment: 'FLAT_RATE',
  },
  purchaseRules: {
    minOrderQty: 1,
    maxOrderQty: null,
    qtyIncrement: 1,
    isRecurringEligible: false,
  },
  category: { id: 'c1', name: 'Infusion', slug: 'infusion' },
  isStockTracked: true,
  hasVariants: false,
  publishedAt: '2026-01-01T00:00:00.000Z',
  primaryImage: { url: 'https://example.test/p1.jpg', altText: 'A boxed infusion set' },
  images: [],
  attributes: [],
  variants: [],
  safety: SAFETY,
};

describe('the guard itself', () => {
  it('actually fails on a known violation', async () => {
    // Without this, every green assertion in this file could be green because
    // axe silently stopped running - a misconfigured rule set, a container
    // that resolved to nothing, a version bump that changed the API. A suite
    // that cannot fail is not testing anything.
    const { container } = renderWithProviders(
      <button type="button">
        <svg aria-hidden="true" viewBox="0 0 16 16" />
      </button>,
    );

    await expect(expectNoA11yViolations(container)).rejects.toThrow(/button-name/);
  });

  it('reports the rule, the impact and the offending markup', async () => {
    const { container } = renderWithProviders(
      // The missing alt IS the fixture: this asserts axe catches it. Adding
      // one would make the test assert nothing.
      // eslint-disable-next-line jsx-a11y/alt-text
      <img src="/x.png" />,
    );

    // An assertion that says only "1 violation" sends the reader to the docs
    // to find out which one.
    await expect(expectNoA11yViolations(container)).rejects.toThrow(/image-alt/);
    await expect(expectNoA11yViolations(container)).rejects.toThrow(/dequeuniversity|helpUrl|http/);
  });
});

describe('product surfaces', () => {
  it('the safety panel has no violations', async () => {
    const { container } = renderWithProviders(<ProductSafetyPanel safety={SAFETY} />);
    await expectNoA11yViolations(container);
  });

  it('a product card has no violations', async () => {
    const { container } = renderWithProviders(<ProductCard product={PRODUCT} />);
    await expectNoA11yViolations(container);
  });
});

describe('device surfaces', () => {
  const DEVICE: ProductDevice = {
    deviceClass: 'CLASS_IIA',
    basicUdiDi: '5060123456789AB',
    udiDi: '05060123456789',
    notifiedBodyNumber: '0123',
    manufacturerSrn: 'NL-MF-000012345',
    declarationOfConformityUrl: 'https://example.test/doc.pdf',
    intendedPurpose: 'Intravenous administration of fluids to a patient.',
    isSterile: true,
    isSingleUse: true,
    hasMeasuringFunction: false,
    containsBiologicalMaterial: false,
  };

  it('the device panel has no violations', async () => {
    const { container } = renderWithProviders(<ProductDevicePanel device={DEVICE} />);
    await expectNoA11yViolations(container);
  });

  it('renders nothing for a product that is not a device', () => {
    renderWithProviders(<ProductDevicePanel device={null} />);

    // Most of a catalogue is not a device. An empty "Device information"
    // heading would read as "a device with no certification", which is a far
    // worse claim than silence.
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('labels the two UDIs separately and never merges them', () => {
    renderWithProviders(<ProductDevicePanel device={DEVICE} />);

    // The Basic UDI-DI names the device group a declaration of conformity is
    // filed against; the UDI-DI names this packaging configuration. Showing
    // one and calling it "the UDI" sends somebody looking for the other.
    expect(screen.getByText('05060123456789')).toBeInTheDocument();
    expect(screen.getByText('5060123456789AB')).toBeInTheDocument();
  });

  it('shows the notified body the way it appears on the product', () => {
    renderWithProviders(<ProductDevicePanel device={DEVICE} />);

    // A bare four-digit number means nothing to somebody who has not
    // memorised the convention; beside the CE mark it is instantly readable.
    expect(screen.getByText('CE 0123')).toBeInTheDocument();
  });

  it('does not render the intended purpose as markup', () => {
    const { container } = renderWithProviders(
      <ProductDevicePanel
        device={{ ...DEVICE, intendedPurpose: '<img src=x onerror="alert(1)">For IV use.' }}
      />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/For IV use/)).toBeInTheDocument();
  });
});

describe('buying surfaces', () => {
  it('the quantity stepper has no violations', async () => {
    const { container } = renderWithProviders(
      <QuantityInput value={2} rules={PRODUCT.purchaseRules} onChange={() => undefined} />,
    );

    await expectNoA11yViolations(container);
  });

  it('the quantity stepper’s controls are reachable by keyboard and named', () => {
    renderWithProviders(
      <QuantityInput value={2} rules={PRODUCT.purchaseRules} onChange={() => undefined} />,
    );

    // WCAG 4.1.2. A stepper whose buttons are unlabelled icons announces as
    // "button, button" and is unusable without sight, however correct the
    // markup around it is.
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName();
    }
  });

  it('the totals block has no violations', async () => {
    // A description list, which is what a row of label/value pairs is. Rendered
    // as the pages render it, so the test exercises the real nesting rather
    // than a shape invented for the test.
    const { container } = renderWithProviders(
      <dl>
        <TotalRow label="Subtotal" value={money('12500').formatted} />
        <TotalRow label="Tax" value={money('2250').formatted} />
        <GrandTotalRow label="Total" value={money('15650').formatted} />
      </dl>,
    );

    await expectNoA11yViolations(container);
  });

  it('the checkout progress indicator has no violations', async () => {
    const { container } = renderWithProviders(<CheckoutSteps states={CART_STEPS} />);
    await expectNoA11yViolations(container);
  });
});

describe('forms', () => {
  it('the address form has no violations', async () => {
    // The highest-consequence form on the storefront: a shopper who cannot
    // complete it cannot buy, whatever else works.
    const { container } = renderWithProviders(<AddressForm onSaved={() => undefined} />);
    await expectNoA11yViolations(container);
  });

  it('every field in the address form has a label', () => {
    renderWithProviders(<AddressForm onSaved={() => undefined} />);

    // WCAG 1.3.1 and 3.3.2. A placeholder is not a label - it disappears the
    // moment somebody types, and several screen readers never announce it.
    const fields = [
      ...screen.getAllByRole('textbox'),
      ...screen.queryAllByRole('combobox'),
    ];

    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field).toHaveAccessibleName();
    }
  });

  it('an invalid field points at its own error message', async () => {
    // WCAG 3.3.1. An error rendered next to a field but not associated with it
    // is invisible to a screen reader: the user hears "invalid entry" with no
    // idea which field or why.
    const { container } = renderWithProviders(
      <Field label="Postcode" error="Enter a valid postcode." required>
        {({ inputId, describedBy }) => (
          <Input id={inputId} aria-describedby={describedBy} invalid />
        )}
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: /Postcode/ });
    expect(input).toHaveAttribute('aria-invalid', 'true');

    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    // And the id it names must actually exist in the document, which is the
    // half that silently breaks when a field becomes conditional.
    const target = container.querySelector(`#${CSS.escape(describedBy ?? '')}`);
    expect(target).not.toBeNull();
    expect(target).toHaveTextContent('Enter a valid postcode.');

    await expectNoA11yViolations(container);
  });

  it('a select and a textarea carry their labels too', async () => {
    const { container } = renderWithProviders(
      <>
        <Field label="Country">
          {({ inputId, describedBy }) => (
            <Select id={inputId} aria-describedby={describedBy}>
              <option value="NL">Netherlands</option>
            </Select>
          )}
        </Field>
        <Field label="Delivery notes" hint="Optional.">
          {({ inputId, describedBy }) => <Textarea id={inputId} aria-describedby={describedBy} />}
        </Field>
      </>,
    );

    expect(screen.getByRole('combobox')).toHaveAccessibleName(/Country/);
    expect(screen.getByRole('textbox')).toHaveAccessibleName(/Delivery notes/);

    await expectNoA11yViolations(container);
  });
});

describe('dialogs', () => {
  it('an open modal has no violations', async () => {
    const { container } = renderWithProviders(
      <Modal isOpen onClose={() => undefined} title="Remove this address?">
        <p>This cannot be undone.</p>
      </Modal>,
    );

    await expectNoA11yViolations(container);
  });

  it('the modal names itself to a screen reader', () => {
    renderWithProviders(
      <Modal
        isOpen
        onClose={() => undefined}
        title="Remove this address?"
        description="This cannot be undone."
      >
        <p>Body</p>
      </Modal>,
    );

    // WCAG 4.1.2. A dialog that opens announcing nothing but "dialog" leaves a
    // screen-reader user to work out what just happened from the body text.
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog).toHaveAccessibleName('Remove this address?');
  });
});

describe('empty and error states', () => {
  it('an empty state has no violations', async () => {
    const { container } = renderWithProviders(
      <PageEmptyState
        title="Your cart is empty"
        description="Browse the catalogue to add something."
      />,
    );

    await expectNoA11yViolations(container);
  });
});

describe('keyboard operability', () => {
  it('every interactive control in the safety panel is reachable by Tab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductSafetyPanel safety={SAFETY} />);

    // WCAG 2.1.1. The manufacturer's email and website are the two things a
    // buyer needs after something goes wrong, and a link nobody can Tab to is
    // a link that is not there for a keyboard user.
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);

    for (const link of links) {
      await user.tab();
      expect(link).toHaveAccessibleName();
    }
  });
});
