/**
 * What the image-search dialog says when the search fails.
 *
 * The route answers every provider failure with one of three published codes,
 * and the dialog words each in the page's own language rather than repeating
 * the server's English. A provider that timed out is IMAGE_SEARCH_BUSY - it
 * used to be a bare 500, shown as "did not work this time" with nothing to act
 * on.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageSearchDialog } from './ImageSearchDialog';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import { makeProduct } from '@/test/fixtures';

const SERVER_ENGLISH = 'Server wording that must not be shown as-is.';

const urlStatics = URL as unknown as Record<string, unknown>;

beforeEach(() => {
  // jsdom has no object URLs - the dialog previews the chosen file with one -
  // and no scrollTo, which the Modal's scroll lock calls on close.
  urlStatics['createObjectURL'] = vi.fn(() => 'blob:preview');
  urlStatics['revokeObjectURL'] = vi.fn();
  // Assigned, not stubbed: the Modal unmounts after afterEach has run, and
  // jsdom's own is only a 'not implemented' error.
  window.scrollTo = vi.fn();
});

afterEach(() => {
  delete urlStatics['createObjectURL'];
  delete urlStatics['revokeObjectURL'];
  vi.unstubAllGlobals();
});

async function searchAndFailWith(status: number, code: string): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(errorResponse(status, code, SERVER_ENGLISH))),
  );

  const { container } = renderWithProviders(
    <ImageSearchDialog isOpen onClose={() => undefined} />,
  );

  const upload = container.ownerDocument.querySelector<HTMLInputElement>(
    'input[type="file"]:not([capture])',
  );
  if (upload === null) throw new Error('upload input not rendered');

  fireEvent.change(upload, {
    target: { files: [new File([new Uint8Array([0xff, 0xd8, 0xff])], 'box.jpg', { type: 'image/jpeg' })] },
  });

  fireEvent.click(await screen.findByRole('button', { name: 'Search with this image' }));
}

describe('ImageSearchDialog failures', () => {
  it.each([
    [503, 'IMAGE_SEARCH_BUSY', 'Image search is busy right now. Please try again in a moment.'],
    [
      503,
      'IMAGE_SEARCH_UNAVAILABLE',
      'Image search is unavailable right now. Please search by name instead.',
    ],
    [
      502,
      'IMAGE_SEARCH_UNREADABLE',
      'That photograph could not be read. Try a clearer one, or search by name.',
    ],
  ])('words %i %s from the code, not the server text', async (status, code, expected) => {
    await searchAndFailWith(status, code);

    await waitFor(() => {
      expect(screen.getByText(expected)).toBeInTheDocument();
    });
    expect(screen.queryByText(SERVER_ENGLISH)).not.toBeInTheDocument();
  });

  it('still shows the server message for a code it has no sentence for', async () => {
    await searchAndFailWith(400, 'VALIDATION_FAILED');

    await waitFor(() => {
      expect(screen.getByText(SERVER_ENGLISH)).toBeInTheDocument();
    });
  });
});

describe('what the dialog tells the customer about their picture', () => {
  it('says, before anything is sent, that the picture goes to an AI service and is not stored', async () => {
    renderWithProviders(<ImageSearchDialog isOpen onClose={() => undefined} />);

    const note = await screen.findByText(/sent to an AI service/i);
    expect(note).toHaveTextContent(/not stored by us/i);
  });

  it('says the matches are approximate once it shows them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            description: 'a box of gloves',
            terms: ['gloves'],
            products: [makeProduct({ name: 'Nitrile gloves', slug: 'nitrile-gloves' })],
            currency: 'INR',
            country: 'IN',
          }),
        ),
      ),
    );

    const { container } = renderWithProviders(<ImageSearchDialog isOpen onClose={() => undefined} />);
    const upload = container.ownerDocument.querySelector<HTMLInputElement>('input[type="file"]:not([capture])');
    if (upload === null) throw new Error('upload input not rendered');
    fireEvent.change(upload, {
      target: { files: [new File([new Uint8Array([0xff, 0xd8, 0xff])], 'box.jpg', { type: 'image/jpeg' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Search with this image' }));

    expect(await screen.findByText(/matches are approximate/i)).toBeInTheDocument();
  });
});
