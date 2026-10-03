/**
 * "Add instructions" on the product page: a small panel under the control.
 *
 *   - it opens inline, labelled as a dialog, with the box focused;
 *   - the counter reads "used/500" and the box cannot hold more than 500;
 *   - Save sends the trimmed text for this product and option, once;
 *   - Cancel and Escape close it, and reopening shows what is saved;
 *   - a failed save keeps the panel open with the words and the error;
 *   - a guest is sent to sign in instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { errorResponse, jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import { ProductInstructionsButton } from './ProductInstructionsButton';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

const PRODUCT = '01PRODUCT00000000000000000';
const VARIANT = '01VARIANT00000000000000000';

function stubApi(options: { stored?: string | null; saveFails?: boolean; saveHangs?: boolean } = {}): Call[] {
  const calls: Call[] = [];
  let stored = options.stored ?? null;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ url, method, body });
      if (url.includes('/account/product-instructions') && method === 'GET') {
        return Promise.resolve(
          jsonResponse({
            instruction: stored === null ? null : { id: 'i1', productId: PRODUCT, variantId: VARIANT, body: stored },
          }),
        );
      }
      if (url.includes('/account/product-instructions') && method === 'POST') {
        if (options.saveHangs === true) return new Promise(() => undefined);
        if (options.saveFails === true) {
          return Promise.resolve(errorResponse(503, 'SERVICE_UNAVAILABLE', 'The service is busy.'));
        }
        stored = String(body['body']);
        return Promise.resolve(
          jsonResponse({
            instruction: stored === '' ? null : { id: 'i1', productId: PRODUCT, variantId: VARIANT, body: stored },
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    }),
  );
  return calls;
}

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function renderButton(isCustomer = true): void {
  renderWithProviders(
    <Routes>
      <Route
        path="/product/:slug"
        element={
          <ProductInstructionsButton
            productId={PRODUCT}
            productName="Examination gloves"
            variantId={VARIANT}
            size="lg"
            variant="secondary"
          />
        }
      />
      <Route path="/login" element={<Where />} />
    </Routes>,
    {
      route: '/product/gloves?size=m',
      session: isCustomer ? makeSession() : makeSession({ isCustomer: false, user: null }),
    },
  );
}

async function open(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: /instructions/i }));
  const panel = await screen.findByRole('dialog', { name: 'Tell the seller what you need' });
  await within(panel).findByRole('textbox');
  return panel;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProductInstructionsButton', () => {
  it('opens a labelled inline panel under the control, with the box focused', async () => {
    stubApi();
    renderButton();
    const panel = await open();

    expect(panel).toHaveAttribute('aria-modal', 'false');
    const box = within(panel).getByRole('textbox', { name: 'Your instructions' });
    await waitFor(() => {
      expect(box).toHaveFocus();
    });
    expect(box).toHaveAttribute('maxlength', '500');
    expect(box.getAttribute('placeholder')).toMatch(/seller and their packing team/);
    expect(within(panel).getByText('0/500')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Close instructions' })).toBeInTheDocument();
  });

  it('counts as you type and never holds more than 500 characters', async () => {
    stubApi();
    renderButton();
    const panel = await open();
    const box = within(panel).getByRole('textbox');

    fireEvent.change(box, { target: { value: 'a'.repeat(125) } });
    expect(within(panel).getByText('125/500')).toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'b'.repeat(520) } });
    expect((box as HTMLTextAreaElement).value).toHaveLength(500);
    expect(within(panel).getByText('500/500')).toBeInTheDocument();
  });

  it('saves the trimmed text for this product and option, once, and shows it on reopening', async () => {
    const calls = stubApi();
    renderButton();
    const panel = await open();

    fireEvent.change(within(panel).getByRole('textbox'), { target: { value: '   Pack in tens, please.  \n' } });
    const save = within(panel).getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Tell the seller what you need' })).toBeNull();
    });
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ productId: PRODUCT, variantId: VARIANT, body: 'Pack in tens, please.' });

    // The control now says Edit, and reopening shows what was saved.
    const reopened = await open();
    expect(within(reopened).getByRole('textbox')).toHaveValue('Pack in tens, please.');
  });

  it('Cancel and Escape throw the draft away and keep what was saved', async () => {
    stubApi({ stored: 'Original note' });
    renderButton();

    let panel = await open();
    const box = await within(panel).findByDisplayValue('Original note');
    fireEvent.change(box, { target: { value: 'Something else' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    panel = await open();
    const again = within(panel).getByRole('textbox');
    expect(again).toHaveValue('Original note');
    fireEvent.change(again, { target: { value: 'Typed then escaped' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // Focus goes back to the control that opened it.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit instructions' })).toHaveFocus();
    });

    panel = await open();
    expect(within(panel).getByRole('textbox')).toHaveValue('Original note');
  });

  it('keeps the panel and the words when the save fails, and says why', async () => {
    stubApi({ saveFails: true });
    renderButton();
    const panel = await open();

    fireEvent.change(within(panel).getByRole('textbox'), { target: { value: 'Keep me' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    expect(await within(panel).findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Tell the seller what you need' })).toBeInTheDocument();
    expect(within(panel).getByRole('textbox')).toHaveValue('Keep me');
  });

  it('disables Save while the save is in flight', async () => {
    stubApi({ saveHangs: true });
    renderButton();
    const panel = await open();

    fireEvent.change(within(panel).getByRole('textbox'), { target: { value: 'Slow network' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });

  it('renders what is stored as text, never as markup', async () => {
    stubApi({ stored: '<img src=x onerror=alert(1)>' });
    renderButton();
    const panel = await open();

    expect(await within(panel).findByDisplayValue('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(panel.querySelector('img')).toBeNull();
  });

  it('sends a guest to sign in and back, without opening anything', async () => {
    stubApi();
    renderButton(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Add instructions' }));

    expect(await screen.findByTestId('where')).toHaveTextContent(
      `/login?next=${encodeURIComponent('/product/gloves?size=m')}`,
    );
  });
});
