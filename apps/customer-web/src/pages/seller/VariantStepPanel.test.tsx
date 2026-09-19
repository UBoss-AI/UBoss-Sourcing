/**
 * The seller's variant step.
 *
 * What is worth asserting here is not that the table renders - it is the
 * handful of behaviours that decide whether a seller ends up with a catalogue
 * that tells the truth:
 *
 *   - **Nothing is ticked for them.** A footwear template offering sizes 5 to
 *     12 must not produce a listing claiming eight sizes nobody checked.
 *   - **"One version" and "not answered yet" are different screens.** A
 *     seller who said no is not asked again.
 *   - **The combination count is shown before it is built**, because seventy
 *     rows is a decision and not a surprise.
 *   - **The generate call sends what the seller ticked**, and nothing else.
 *   - **Removing is possible and reads as "not offered"**, which is the
 *     distinction the whole feature rests on.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VariantStepPanel } from './VariantStepPanel';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type { DraftVariantRow, DraftView, VariantTemplateAxis } from '@/lib/seller';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  // Every render fetches the seller's warehouses for the stock column.
  fetchMock.mockResolvedValue(
    jsonResponse({ locations: [{ id: 'L1'.padEnd(26, '0'), name: 'Main store' }], map: {} }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function axis(key: string, label: string, suggestions: string[]): VariantTemplateAxis {
  return {
    key,
    label,
    importance: 'RECOMMENDED',
    input: 'TEXT_SELECT',
    display: 'CHIPS',
    suggestions,
    allowsCustomValues: true,
    affectsSku: true,
    isFilterable: true,
    inTitle: true,
    sortOrder: 0,
    sort: 'GIVEN',
  };
}

function row(options: Record<string, string>, over: Partial<DraftVariantRow> = {}): DraftVariantRow {
  return {
    optionSignature: Object.entries(options)
      .map(([key, value]) => `${key}:${value.toLowerCase()}`)
      .join('|'),
    options,
    name: Object.values(options).join(' / '),
    sku: `SKU-${Object.values(options).join('-')}`,
    isActive: true,
    priceMinor: '49900',
    stock: [],
    ...over,
  };
}

function draft(over: Partial<DraftView> = {}): DraftView {
  return {
    id: 'D1'.padEnd(26, '0'),
    status: 'DRAFT',
    categoryId: 'C1'.padEnd(26, '0'),
    brandId: null,
    brandName: null,
    matchedProductId: null,
    sellerSku: 'TSH',
    attributes: {},
    offer: {},
    stock: [],
    packaging: {},
    generatedTitle: 'Cotton T-shirt',
    sellerEditedTitle: null,
    sections: [],
    issues: [],
    isSubmittable: false,
    canPreviewTitle: false,
    reviewComment: null,
    version: 1,
    updatedAt: new Date().toISOString(),
    variantAxes: null,
    variants: null,
    variantTemplate: {
      categorySlug: 'clothing-textiles',
      subcategorySlug: 'everyday-clothing',
      label: 'Everyday Clothing',
      axes: [
        axis('size', 'Size', ['S', 'M', 'L', 'XL']),
        axis('colour', 'Colour', ['Black', 'White', 'Navy']),
      ],
    },
    variantProjection: { total: 0, warnAbove: 100, maximum: 500, exceedsMaximum: false },
    media: [],
    schema: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('the variant question', () => {
  it('asks before assuming, and offers both answers', () => {
    renderWithProviders(<VariantStepPanel draft={draft()} onBack={() => undefined} />);

    expect(
      screen.getByText(/does this product come in more than one version/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /no, just one version/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /yes, it has versions/i })).toBeInTheDocument();
  });

  it('stops asking once the seller has said one version', () => {
    renderWithProviders(
      <VariantStepPanel draft={draft({ variantAxes: [] })} onBack={() => undefined} />,
    );

    expect(screen.getByText(/one version only/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/does this product come in more than one version/i),
    ).not.toBeInTheDocument();
  });

  it('does not turn "yes" into "no" on a category with no suggestions', async () => {
    /*
     * Medical devices, and any department a business added itself, have no
     * suggested options. Seeding the axis list with nothing and saving it
     * would store the empty list - which is how the seller says "one version
     * only" - so the seller would press "yes" and be told they had said no.
     */
    const user = userEvent.setup();

    renderWithProviders(
      <VariantStepPanel draft={draft({ variantTemplate: null })} onBack={() => undefined} />,
    );

    await user.click(screen.getByRole('button', { name: /yes, it has versions/i }));

    // The picker, not the "one version only" screen.
    expect(await screen.findByLabelText(/add an option of your own/i)).toBeInTheDocument();
    expect(screen.queryByText(/one version only/i)).not.toBeInTheDocument();

    // And nothing was saved, because there is nothing to save yet.
    expect(
      fetchMock.mock.calls.filter(([, init]) =>
        (init?.method ?? '').toUpperCase() === 'PATCH',
      ),
    ).toHaveLength(0);
  });

  it('lets a seller name an option the department does not suggest', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <VariantStepPanel draft={draft({ variantTemplate: null })} onBack={() => undefined} />,
    );

    await user.click(screen.getByRole('button', { name: /yes, it has versions/i }));
    await user.type(await screen.findByLabelText(/add an option of your own/i), 'Tip style');
    await user.click(screen.getByRole('button', { name: /add option/i }));

    // Folded to the key the server would store, and now editable.
    expect(await screen.findByText('tip_style')).toBeInTheDocument();
  });

  it('lets the seller change their mind back', () => {
    renderWithProviders(
      <VariantStepPanel draft={draft({ variantAxes: [] })} onBack={() => undefined} />,
    );

    expect(screen.getByRole('button', { name: /actually, it has versions/i })).toBeInTheDocument();
  });
});

describe('choosing axes and values', () => {
  it('ticks nothing on the seller\'s behalf', () => {
    renderWithProviders(
      <VariantStepPanel
        draft={draft({ variantAxes: [{ axisKey: 'size', values: [] }] })}
        onBack={() => undefined}
      />,
    );

    // Every suggested size is offered and every one of them is off. A shirt
    // must not arrive claiming four sizes nobody confirmed.
    for (const size of ['S', 'M', 'L', 'XL']) {
      expect(screen.getByRole('button', { name: size, pressed: false })).toBeInTheDocument();
    }
  });

  it('counts the combinations before building them', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <VariantStepPanel
        draft={draft({ variantAxes: [{ axisKey: 'size', values: [] }] })}
        onBack={() => undefined}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'S', pressed: false }));
    await user.click(screen.getByRole('button', { name: 'M', pressed: false }));

    // The count is on the button, which is the thing the seller reads before
    // committing to seventy rows.
    expect(
      await screen.findByRole('button', { name: /create 2 combinations/i }),
    ).toBeInTheDocument();
  });

  it('sends only the values the seller ticked', async () => {
    const user = userEvent.setup();
    const current = draft({ variantAxes: [{ axisKey: 'size', values: [] }] });

    renderWithProviders(<VariantStepPanel draft={current} onBack={() => undefined} />);

    await user.click(screen.getByRole('button', { name: 'S', pressed: false }));
    await user.click(screen.getByRole('button', { name: 'L', pressed: false }));

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...current, variants: [row({ size: 'S' }), row({ size: 'L' })] }),
    );

    await user.click(screen.getByRole('button', { name: /create 2 combinations/i }));

    await waitFor(() => {
      // `fetch` takes a string, a URL or a Request. The client here always
      // passes a string, so narrowing to that is honest rather than a cast
      // that would stringify a Request as "[object Object]" and match nothing.
      const call = fetchMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/variants/generate'),
      );
      expect(call).toBeDefined();

      const body = JSON.parse((call?.[1]?.body as string | undefined) ?? '{}') as {
        axes: { axisKey: string; values: { label: string }[] }[];
      };

      // Two values, not the four the template suggested.
      expect(body.axes[0]?.values.map((value) => value.label)).toEqual(['S', 'L']);
    });
  });

  it('refuses to build a matrix past the cap and says why', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <VariantStepPanel
        draft={draft({
          variantAxes: [{ axisKey: 'size', values: [] }],
          variantProjection: { total: 0, warnAbove: 100, maximum: 2, exceedsMaximum: false },
        })}
        onBack={() => undefined}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'S', pressed: false }));
    await user.click(screen.getByRole('button', { name: 'M', pressed: false }));
    await user.click(screen.getByRole('button', { name: 'L', pressed: false }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/most one listing can hold/i);
  });
});

describe('the matrix', () => {
  const withRows = draft({
    variantAxes: [{ axisKey: 'size', values: [{ label: 'S' }, { label: 'M' }] }],
    variants: [row({ size: 'S' }), row({ size: 'M' }, { isActive: false })],
  });

  it('shows a row per combination with its own code', () => {
    renderWithProviders(<VariantStepPanel draft={withRows} onBack={() => undefined} />);

    const table = screen.getByRole('table');
    expect(within(table).getByDisplayValue('SKU-S')).toBeInTheDocument();
    expect(within(table).getByDisplayValue('SKU-M')).toBeInTheDocument();
  });

  it('marks a switched-off combination as not offered', () => {
    renderWithProviders(<VariantStepPanel draft={withRows} onBack={() => undefined} />);

    // Scoped to the table: the note underneath it explains both states in
    // prose, and matching that would prove nothing about the row.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Not offered')).toBeInTheDocument();
    expect(within(table).queryByText(/out of stock/i)).not.toBeInTheDocument();
  });

  it('filters by code without touching the stored rows', async () => {
    const user = userEvent.setup();
    renderWithProviders(<VariantStepPanel draft={withRows} onBack={() => undefined} />);

    await user.type(screen.getByLabelText(/find a combination/i), 'SKU-S');

    const table = screen.getByRole('table');
    await waitFor(() => {
      expect(within(table).queryByDisplayValue('SKU-M')).not.toBeInTheDocument();
    });
    expect(within(table).getByDisplayValue('SKU-S')).toBeInTheDocument();
  });

  it('offers a per-row remove, because a combination nobody makes is removed', () => {
    renderWithProviders(<VariantStepPanel draft={withRows} onBack={() => undefined} />);

    const table = screen.getByRole('table');
    expect(within(table).getByRole('button', { name: 'Remove S' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Remove M' })).toBeInTheDocument();
  });

  it('labels every editable cell, so the table can be used from a keyboard', () => {
    renderWithProviders(<VariantStepPanel draft={withRows} onBack={() => undefined} />);

    expect(screen.getByLabelText('Code for S')).toBeInTheDocument();
    expect(screen.getByLabelText('Price for S')).toBeInTheDocument();
    expect(screen.getByLabelText('Stock for S')).toBeInTheDocument();
    expect(screen.getByLabelText('S on sale')).toBeInTheDocument();
  });
});
