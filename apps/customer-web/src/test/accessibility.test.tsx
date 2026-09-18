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
import { screen, within } from '@testing-library/react';
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
import { HeroSearch } from '@/components/hero-search/HeroSearch';
import { AiMessage } from '@/pages/ai/AiMessage';
import { CartModeTabs } from '@/components/CartModeTabs';
import { CadenceFields } from '@/pages/schedule/CadenceFields';
import { DatePicker } from '@/components/DatePicker';
import { ModernDonutCard } from '@/components/dashboard/ModernDonutCard';
import { AiInsightsCard } from '@/components/dashboard/AiInsightsCard';
import { RangeTabs } from '@/components/dashboard/controls';
import { emptyCadenceDraft } from '@/lib/schedule-cadence';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import type {
  Money,
  Product,
  ProductDevice,
  ProductSafety,
  StorefrontConfig,
} from '@/lib/types';

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

describe('search and AI Mode', () => {
  /**
   * The hero search module.
   *
   * A text input with no visible label, a row that looks like tabs and is not,
   * and four controls packed into one box — which is a lot of ways to end up
   * with an unlabelled button. It is checked in both of its states, because
   * they are two different documents: the module opens as a single pill, and
   * the bar, the row and the camera only exist once it has been pressed. A
   * closed control whose only accessible name is a magnifier glyph is the
   * failure this pair is here to catch.
   */
  async function openHeroBar(): Promise<void> {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Search the catalogue' }));
    await screen.findByRole('textbox', { name: 'Search the catalogue' });
  }

  it('the hero search module has no violations while it is closed', async () => {
    const { container } = renderWithProviders(<HeroSearch />, {
      config: {
        ...FALLBACK_CONFIG,
        features: { ...FALLBACK_CONFIG.features, assistant: true, imageSearch: true },
      },
    });

    await expectNoA11yViolations(container);
  });

  it('the hero search module has no violations once it is open', async () => {
    const { container } = renderWithProviders(<HeroSearch />, {
      config: {
        ...FALLBACK_CONFIG,
        features: { ...FALLBACK_CONFIG.features, assistant: true, imageSearch: true },
      },
    });

    await openHeroBar();
    await expectNoA11yViolations(container);
  });

  it('every control in the search bar has an accessible name', async () => {
    renderWithProviders(<HeroSearch />, {
      config: {
        ...FALLBACK_CONFIG,
        features: { ...FALLBACK_CONFIG.features, assistant: true, imageSearch: true },
      },
    });

    await openHeroBar();

    // The voice and camera buttons are icons. Without a name they announce as
    // "button", which is the single most common icon-button failure.
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName();
    }

    // The search box's label is visually hidden, not absent.
    expect(screen.getByRole('textbox')).toHaveAccessibleName();
  });

  /**
   * An AI reply.
   *
   * Model output is rendered as text with one exception — a `/product/...`
   * path becomes a link — so the thing to check is that the link carries a
   * name and the actions under the bubble do too.
   */
  it('an AI reply and its actions have no violations', async () => {
    const { container } = renderWithProviders(
      <AiMessage
        message={{
          role: 'assistant',
          content: 'We list three, starting at /product/accu-flow.',
        }}
        isTruncated={false}
        onAskAgain={() => undefined}
      />,
    );

    await expectNoA11yViolations(container);
    expect(screen.getByRole('link', { name: '/product/accu-flow' })).toBeInTheDocument();
  });
});

/**
 * The two ways to spend a basket.
 *
 * The tabs are links between two routes rather than a `role="tablist"`, so
 * what has to hold is what holds for navigation: an accessible name on each,
 * and `aria-current` on the one you are on. A control whose selected state
 * lives only in a background colour is invisible to a screen reader and to
 * anybody who cannot distinguish the two blues.
 */
describe('the cart mode tabs', () => {
  const WITH_SCHEDULES: StorefrontConfig = {
    ...FALLBACK_CONFIG,
    features: { ...FALLBACK_CONFIG.features, recurringOrders: true },
  };

  it('has no violations, and carries its selected state in the markup', async () => {
    const { container } = renderWithProviders(<CartModeTabs current="instant" />, {
      config: WITH_SCHEDULES,
    });

    await expectNoA11yViolations(container);

    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAccessibleName();
    }

    expect(screen.getByRole('link', { name: /instant buy/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

/**
 * The controls that decide when a standing order runs.
 *
 * Every one of them is a labelled form control, including the two that sit
 * inside a radio row and so have no visible label of their own — an unlabelled
 * date box in a sentence reads to a screen reader as an unlabelled date box.
 */
describe('the schedule cadence controls', () => {
  /*
   * A generous timeout, and the reason is the timezone picker.
   *
   * It offers the platform's whole IANA list - some six hundred options - and
   * axe walks every node in the container twice here, once per state. That is
   * a cost this test pays and a browser does not: the list renders once when
   * the panel mounts and is then a plain select.
   *
   * Sixty seconds rather than thirty, because thirty was not generous: alone
   * this finishes in about twenty-nine, and in a full run - where vitest is
   * working several files at once on the same cores - it went over and failed
   * a suite that was not broken. A budget set that close to the real cost is a
   * test that reports the machine's load rather than the code's behaviour.
   */
  it('label every control, in both states', { timeout: 60_000 }, async () => {
    for (const disabled of [false, true]) {
      const { container, unmount } = renderWithProviders(
        <CadenceFields
          draft={emptyCadenceDraft('Asia/Kolkata')}
          disabled={disabled}
          onChange={() => undefined}
        />,
      );

      await expectNoA11yViolations(container);

      for (const box of screen.getAllByRole('combobox')) {
        expect(box).toHaveAccessibleName();
      }

      unmount();
    }
  });
});

/**
 * The calendar.
 *
 * A custom date field is one of the easiest controls to build inaccessibly:
 * thirty-five buttons in a table, a popover with no name, and a selected state
 * that lives only in a background colour. So what is checked here is the
 * markup rather than the look — the grid's headers, the popover's name, and
 * the fact that only one day is in the tab order.
 */
describe('the date picker', () => {
  it('has no violations, open or closed', async () => {
    const user = userEvent.setup();

    const { container } = renderWithProviders(
      <DatePicker
        label="Delivery date"
        value="2026-09-24"
        min="2026-09-18"
        onChange={() => undefined}
      />,
    );

    await expectNoA11yViolations(container);

    const trigger = screen.getByRole('button', { name: /Delivery date/i });
    // The trigger says what it is AND what pressing it does. A button's
    // accessible name comes from its content, so the field's visible label is
    // not enough on its own.
    expect(trigger).toHaveAccessibleName(/Delivery date: .*24 September 2026.*calendar/i);

    await user.click(trigger);
    await expectNoA11yViolations(container);

    // The popover is named, so a screen reader can say which field it belongs
    // to rather than announcing an unnamed dialog.
    expect(screen.getByRole('dialog')).toHaveAccessibleName(/Delivery date/i);

    // Every day carries its full date, because "24" on its own is not a date.
    // Scoped to the grid: the trigger's own name contains the same date.
    expect(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: /^Thursday, 24 September 2026$/i,
      }),
    ).toBeInTheDocument();

    // And the weekday headers are real column headers with real day names —
    // "M" is not a day of the week.
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(7);
    expect(headers.map((header) => header.textContent)).toContain('MMonday');
  });
});

/**
 * The dashboard.
 *
 * Three surfaces, here for three different reasons:
 *
 *   - the ring, because a chart is the easiest thing on a page to build so
 *     that only sighted pointer users can read it;
 *   - the range tabs, because a tab list with a hand-rolled roving tabindex is
 *     the easiest thing on a page to get subtly wrong;
 *   - the insights panel, because it is a live region and a form in one card.
 */
describe('the dashboard', () => {
  const DONUT_LABELS = {
    status: 'Status',
    value: 'Orders',
    share: 'Share',
    viewAsTable: 'View as a table',
    clearFilter: 'Clear filter',
    filteredBy: 'Showing {{label}} only',
    empty: 'Nothing to show.',
    error: 'Something went wrong.',
    retry: 'Try again',
    loading: 'Loading',
    remainder: '{{count}} not shown',
    clampNote: 'Small slices are drawn at a readable minimum.',
  };

  const SEGMENTS = [
    { id: 'action', label: 'Waiting on you', value: 3, step: 'warning' as const },
    { id: 'processing', label: 'Being prepared', value: 5, step: 3 as const },
    { id: 'delivered', label: 'Delivered', value: 11, step: 'success' as const },
    { id: 'closed', label: 'Cancelled or returned', value: 1, step: 'danger' as const },
  ];

  it('has no violations with data in it', async () => {
    const { container } = renderWithProviders(
      <ModernDonutCard
        title="My orders"
        total={20}
        centerLabel="MY ORDERS"
        unitLabel="orders in this period"
        segments={SEGMENTS}
        selectedSegment={null}
        onSegmentSelect={() => undefined}
        labels={DONUT_LABELS}
      />,
    );

    await expectNoA11yViolations(container);
  });

  it('has no violations with a segment selected', async () => {
    const { container } = renderWithProviders(
      <ModernDonutCard
        title="My orders"
        total={20}
        centerLabel="MY ORDERS"
        unitLabel="orders in this period"
        segments={SEGMENTS}
        selectedSegment="action"
        onSegmentSelect={() => undefined}
        labels={DONUT_LABELS}
      />,
    );

    await expectNoA11yViolations(container);
  });

  it('has no violations while loading, or when empty', async () => {
    const loading = renderWithProviders(
      <ModernDonutCard
        title="My orders"
        total={0}
        centerLabel="MY ORDERS"
        unitLabel="orders"
        segments={[]}
        selectedSegment={null}
        onSegmentSelect={() => undefined}
        loading
        labels={DONUT_LABELS}
      />,
    );
    await expectNoA11yViolations(loading.container);

    const empty = renderWithProviders(
      <ModernDonutCard
        title="My orders"
        total={0}
        centerLabel="MY ORDERS"
        unitLabel="orders"
        segments={SEGMENTS.map((segment) => ({ ...segment, value: 0 }))}
        selectedSegment={null}
        onSegmentSelect={() => undefined}
        labels={DONUT_LABELS}
      />,
    );
    await expectNoA11yViolations(empty.container);
  });

  it('gives the ring a name that says what it shows', () => {
    renderWithProviders(
      <ModernDonutCard
        title="My orders"
        total={20}
        centerLabel="MY ORDERS"
        unitLabel="orders in this period"
        segments={SEGMENTS}
        selectedSegment={null}
        onSegmentSelect={() => undefined}
        labels={DONUT_LABELS}
      />,
    );

    /*
     * The arcs are decoration; the ring as a whole is an image whose label
     * carries every figure. So somebody who cannot see it learns what the
     * chart says without tabbing through eight segments to find out.
     */
    const chart = screen.getByRole('img');
    const label = chart.getAttribute('aria-label') ?? '';

    expect(label).toContain('My orders');
    expect(label).toContain('Waiting on you: 3');
    expect(label).toContain('Delivered: 11');
  });

  it('makes every segment a real button with a pressed state', () => {
    renderWithProviders(
      <ModernDonutCard
        title="My orders"
        total={20}
        centerLabel="MY ORDERS"
        unitLabel="orders"
        segments={SEGMENTS}
        selectedSegment="delivered"
        onSegmentSelect={() => undefined}
        labels={DONUT_LABELS}
      />,
    );

    for (const segment of SEGMENTS) {
      const entry = screen.getByRole('button', { name: new RegExp(segment.label, 'i') });
      expect(entry).toHaveAttribute('aria-pressed', segment.id === 'delivered' ? 'true' : 'false');
    }
  });

  it('gives every legend entry a target big enough to tap', () => {
    // 44px is the practical floor for a control somebody presses on a phone.
    // A legend row is otherwise about 28px, which is why the minimum is set
    // rather than inherited.
    renderWithProviders(
      <ModernDonutCard
        title="My orders"
        total={20}
        centerLabel="MY ORDERS"
        unitLabel="orders"
        segments={SEGMENTS}
        selectedSegment={null}
        onSegmentSelect={() => undefined}
        labels={DONUT_LABELS}
      />,
    );

    for (const segment of SEGMENTS) {
      const entry = screen.getByRole('button', { name: new RegExp(segment.label, 'i') });
      expect(entry.className).toContain('min-h-[2.75rem]');
    }
  });

  it('has no violations on the range tabs', async () => {
    const { container } = renderWithProviders(
      <RangeTabs
        options={[
          { key: 'today', label: 'Today' },
          { key: '7d', label: 'Last 7 days' },
          { key: '30d', label: 'Last 30 days' },
          { key: 'custom', label: 'Custom' },
        ]}
        value="30d"
        onChange={() => undefined}
        labels={{ legend: 'Reporting period', from: 'From', to: 'To', apply: 'Apply' }}
      />,
    );

    await expectNoA11yViolations(container);
  });

  it('leaves exactly one range tab in the tab order', () => {
    // The roving tabindex. Four stops for four tabs would mean tabbing past
    // the whole control to reach the chart; one stop plus arrow keys is what
    // a tab list is supposed to be.
    renderWithProviders(
      <RangeTabs
        options={[
          { key: 'today', label: 'Today' },
          { key: '7d', label: 'Last 7 days' },
          { key: '30d', label: 'Last 30 days' },
          { key: 'custom', label: 'Custom' },
        ]}
        value="30d"
        onChange={() => undefined}
        labels={{ legend: 'Reporting period', from: 'From', to: 'To', apply: 'Apply' }}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    const reachable = tabs.filter((tab) => tab.getAttribute('tabindex') !== '-1');

    expect(tabs).toHaveLength(4);
    expect(reachable).toHaveLength(1);
    expect(reachable[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('has no violations on the insights panel, idle or answered', async () => {
    const labels = {
      title: 'UBOSS AI Insights',
      askLabel: 'Ask a question about this dashboard',
      ask: 'Ask',
      asking: 'Thinking',
      asked: 'Answer ready',
      askFailed: 'That did not work.',
      explainChart: 'Explain this chart',
      explaining: 'Reading',
      explained: 'Explained',
      explainFailed: 'Could not explain',
      suggestions: 'Try asking',
      findings: 'What stands out',
      nextSteps: 'Suggested next steps',
      evidence: 'The figures behind this',
      generated: 'Generated {{when}}',
      disclosure: 'Answers are generated.',
      deterministic: 'No AI provider is configured.',
      unavailable: 'The AI provider could not be reached.',
      idle: 'Ask a question about the figures on this page.',
      severity: { info: 'Note', attention: 'Attention', urgent: 'Urgent' },
    };

    const idle = renderWithProviders(
      <AiInsightsCard
        labels={labels}
        streamedSummary=""
        insight={null}
        busy={false}
        failed={false}
        onExplain={() => undefined}
        onAsk={() => undefined}
        suggestions={['Which orders need my attention?']}
        placeholders={['Which orders need my attention?']}
        renderLink={(href, children) => <a href={href}>{children}</a>}
      />,
    );
    await expectNoA11yViolations(idle.container);

    const answered = renderWithProviders(
      <AiInsightsCard
        labels={labels}
        streamedSummary=""
        insight={{
          summary: 'Three orders are waiting for payment.',
          findings: [
            {
              title: 'Awaiting payment: 3',
              detail: 'Three orders cannot progress until they are paid.',
              severity: 'urgent',
              evidence: ['orders.actionRequired'],
            },
          ],
          suggestedActions: [
            {
              label: 'Review unpaid orders',
              detail: 'Three are waiting.',
              metricKey: 'orders.actionRequired',
              href: '/account/orders',
            },
          ],
          evidence: [
            {
              metricKey: 'orders.actionRequired',
              label: 'Orders awaiting payment',
              value: 3,
              unit: 'orders',
              href: '/account/orders',
            },
          ],
          generatedAt: '2026-09-17T09:00:00.000Z',
          window: { from: '2026-08-18T00:00:00.000Z', to: '2026-09-17T00:00:00.000Z' },
          metricKeys: ['orders.actionRequired'],
          source: 'deterministic',
          model: null,
          fallbackReason: 'not-configured',
        }}
        busy={false}
        failed={false}
        onExplain={() => undefined}
        onAsk={() => undefined}
        suggestions={['Which orders need my attention?']}
        placeholders={['Which orders need my attention?']}
        renderLink={(href, children) => <a href={href}>{children}</a>}
        generatedLabel="2 minutes ago"
      />,
    );
    await expectNoA11yViolations(answered.container);
  });
});
