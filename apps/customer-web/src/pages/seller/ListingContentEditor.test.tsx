/**
 * The seller's description and specifications editor.
 *
 *   - Groups, rows and sections can be added, moved and removed, and Save sends
 *     exactly the list on screen.
 *   - The server's answer about a field is shown beside that field.
 *   - A listing under review, or a shared page, is read only and says why.
 *   - The preview is the product page's own component.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type { ListingContentView } from '@/lib/seller';
import { ListingContentEditor } from './ListingContentEditor';

const DRAFT = '01DRAFT0000000000000000000';

function view(over: Partial<ListingContentView> = {}): ListingContentView {
  return {
    content: {
      specifications: [
        {
          group: 'TECHNICAL',
          rows: [
            { label: 'Capacity', value: '750', unit: 'ml', highlight: true },
            { label: 'Voltage', value: '12', unit: 'V', highlight: false },
          ],
        },
      ],
      descriptionSections: [],
      variantOverrides: [],
    },
    variants: [],
    images: [],
    editable: true,
    appliesTo: 'draft',
    ...over,
  };
}

interface Call {
  method: string;
  body: Record<string, unknown>;
}

function stub(initial: ListingContentView, onPut?: (body: Record<string, unknown>) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ method, body });
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith(`/seller/listing-drafts/${DRAFT}/content`) && method === 'PUT') {
        return Promise.resolve(onPut?.(body) ?? jsonResponse({ ...initial, content: body }));
      }
      return Promise.resolve(jsonResponse(initial));
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the listing content editor', () => {
  it('adds, moves and removes rows, and saves exactly what is on screen', async () => {
    const calls = stub(view());
    renderWithProviders(<ListingContentEditor draftId={DRAFT} />);
    expect(await screen.findByDisplayValue('Capacity')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Move down: Capacity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove: Voltage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a specification' }));
    const labels = screen.getAllByLabelText('Label');
    fireEvent.change(labels.at(-1) as HTMLElement, { target: { value: 'Weight' } });
    fireEvent.change(screen.getAllByLabelText('Value').at(-1) as HTMLElement, { target: { value: '0.4' } });
    fireEvent.change(screen.getAllByLabelText('Unit').at(-1) as HTMLElement, { target: { value: 'kg' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add a section' }));
    fireEvent.change(screen.getByLabelText('Heading'), { target: { value: 'Overview' } });
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Keeps drinks cold.' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PUT')).toBe(true);
    });
    const sent = calls.find((call) => call.method === 'PUT')?.body as {
      specifications: { group: string; rows: { label: string; unit: string | null }[] }[];
      descriptionSections: { heading: string; body: string }[];
    };
    expect(sent.specifications[0]?.rows.map((row) => [row.label, row.unit])).toEqual([
      ['Capacity', 'ml'],
      ['Weight', 'kg'],
    ]);
    expect(sent.descriptionSections).toEqual([{ heading: 'Overview', body: 'Keeps drinks cold.', imageMediaId: null, altText: null }]);
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('shows the server’s answer beside the field it is about', async () => {
    stub(view(), () =>
      jsonResponse(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Some of the description or specifications need fixing.',
            details: [{ field: 'specifications.0.rows.1.label', code: 'DUPLICATE_LABEL' }],
          },
        },
        400,
      ),
    );
    renderWithProviders(<ListingContentEditor draftId={DRAFT} />);
    await screen.findByDisplayValue('Voltage');
    fireEvent.change(screen.getByDisplayValue('Voltage'), { target: { value: 'Capacity' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const message = await screen.findByText('This label is already used on this product.');
    const field = screen.getAllByLabelText('Label')[1];
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('This label is already used on this product.');
    expect(message).toBeInTheDocument();
  });

  it('is read only, and says why, while the listing is with the moderator', async () => {
    stub(view({ editable: false, appliesTo: 'draft' }));
    renderWithProviders(<ListingContentEditor draftId={DRAFT} />);
    expect(await screen.findByText(/with the marketplace for review/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Capacity')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says a shared page is changed through the marketplace', async () => {
    stub(view({ editable: false, appliesTo: 'live' }));
    renderWithProviders(<ListingContentEditor draftId={DRAFT} />);
    expect(await screen.findByText(/shared with other sellers/)).toBeInTheDocument();
  });

  it('previews what a buyer will read', async () => {
    stub(view());
    renderWithProviders(<ListingContentEditor draftId={DRAFT} />);
    await screen.findByDisplayValue('Capacity');
    const toggle = screen.getByRole('button', { name: 'Preview' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const preview = document.getElementById(toggle.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(within(preview).getByRole('heading', { name: 'Technical specifications' })).toBeInTheDocument();
    expect(within(preview).getAllByText('750 ml').length).toBeGreaterThan(0);
  });
});
