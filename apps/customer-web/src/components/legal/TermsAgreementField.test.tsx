/**
 * The Terms checkbox and its dialog.
 *
 * What is pinned here is who is allowed to tick the box: only I agree in the
 * dialog. Opening, scrolling, reaching the end, Cancel, Close, Escape, Space
 * and Enter must all leave it empty, and unticking then ticking again must
 * mean reading and agreeing again.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/harness';
import type { CurrentLegalDocument } from '@/lib/legal';
import type { CurrentTerms } from './useCurrentTerms';
import { TermsAgreementField } from './TermsAgreementField';
import { atEnd } from './useReadToEnd';

function termsFor(id: string, version = '2026-10-01'): CurrentTerms {
  const current: CurrentLegalDocument = {
    document: {
      id,
      kind: 'PLATFORM_TERMS',
      version,
      locale: 'en',
      title: 'Terms and Conditions',
      body: '## One\nFirst clause.\n\n## Two\nSecond clause.',
      changeSummary: null,
      effectiveAt: '2026-10-01T00:00:00.000Z',
      publishedAt: '2026-09-30T00:00:00.000Z',
      contentSha256: 'b'.repeat(64),
    },
    requestedLocale: 'en',
    isFallback: false,
  };
  return { state: { status: 'ready', current }, reload: vi.fn() };
}

function Harness({
  terms,
  onValue,
  replaceWith,
}: {
  terms: CurrentTerms;
  onValue?: (value: string | null) => void;
  /** Terms that arrive later - a new version, or another language. */
  replaceWith?: CurrentTerms;
}): React.JSX.Element {
  const [value, setValue] = useState<string | null>(null);
  const [shown, setShown] = useState(terms);
  return (
    <>
      {replaceWith !== undefined && (
        <button
          type="button"
          onClick={() => {
            setShown(replaceWith);
          }}
        >
          New terms arrive
        </button>
      )}
    <TermsAgreementField
      terms={shown}
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
    </>
  );
}

const checkbox = (): HTMLElement => screen.getByRole('checkbox', { name: /terms and conditions/i });
const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Terms and Conditions' });
const agreeButton = (): HTMLElement => within(dialog()).getByRole('button', { name: 'I agree' });

/** Make the text box behave as though its text is taller than it is. */
function makeScrollable(region: HTMLElement, { height = 200, content = 1000 } = {}): void {
  Object.defineProperty(region, 'clientHeight', { configurable: true, value: height });
  Object.defineProperty(region, 'scrollHeight', { configurable: true, value: content });
}

/** Every element reports text taller than its box until `restore` is called. */
function tallTextEverywhere(): () => void {
  const proto = HTMLElement.prototype;
  const saved = {
    clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
    scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
  };
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 200 });
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 1000 });
  return () => {
    delete (proto as unknown as Record<string, unknown>)['scrollHeight'];
    if (saved.clientHeight !== undefined) Object.defineProperty(proto, 'clientHeight', saved.clientHeight);
    else delete (proto as unknown as Record<string, unknown>)['clientHeight'];
  };
}

async function openDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(checkbox());
  expect(dialog()).toBeVisible();
}

describe('TermsAgreementField', () => {
  it('starts unticked, and ticking it opens the Terms instead of ticking it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness terms={termsFor('01JDOC00000000000000000001')} />);

    expect(checkbox()).not.toBeChecked();
    await openDialog(user);
    expect(checkbox()).not.toBeChecked();
  });

  it('opens the Terms from the words in the sentence too', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness terms={termsFor('01JDOC00000000000000000001')} />);

    await user.click(screen.getByRole('button', { name: 'Terms and Conditions' }));
    expect(dialog()).toBeVisible();
    expect(checkbox()).not.toBeChecked();
  });

  it('opens the Terms with Space and with Enter on the box, and ticks nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness terms={termsFor('01JDOC00000000000000000001')} />);

    checkbox().focus();
    await user.keyboard(' ');
    expect(dialog()).toBeVisible();
    expect(checkbox()).not.toBeChecked();

    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    checkbox().focus();
    await user.keyboard('{Enter}');
    expect(dialog()).toBeVisible();
    expect(checkbox()).not.toBeChecked();
  });

  it('keeps I agree disabled until the end of the text is reached, and says why', async () => {
    const user = userEvent.setup();
    // Tall text from the very first measurement. Set after opening, the
    // dialog's own post-layout check can win the race on a busy machine and
    // see jsdom's empty layout - which is text that fits.
    const restore = tallTextEverywhere();
    try {
      renderWithProviders(<Harness terms={termsFor('01JDOC00000000000000000001')} />);
      await openDialog(user);
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    } finally {
      restore();
    }

    const region = within(dialog()).getByRole('region');
    makeScrollable(region);
    fireEvent.scroll(region);
    expect(agreeButton()).toBeDisabled();
    expect(agreeButton()).toHaveAccessibleDescription('Read all terms before accepting.');

    // Most of the way is not the end.
    region.scrollTop = 500;
    fireEvent.scroll(region);
    expect(agreeButton()).toBeDisabled();

    // Within a few pixels of the bottom is.
    region.scrollTop = 795;
    fireEvent.scroll(region);
    await waitFor(() => {
      expect(agreeButton()).toBeEnabled();
    });
    expect(within(dialog()).getByRole('status')).toHaveTextContent('You have reached the end');

    // Scrolling back up to re-read a clause does not take it away again.
    region.scrollTop = 0;
    fireEvent.scroll(region);
    expect(agreeButton()).toBeEnabled();
    // And reaching the end ticked nothing.
    expect(checkbox()).not.toBeChecked();
  });

  it('enables I agree at once when the whole text fits', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness terms={termsFor('01JDOC00000000000000000001')} />);
    await openDialog(user);

    // jsdom lays nothing out, so scrollHeight equals clientHeight: text that fits.
    await waitFor(() => {
      expect(agreeButton()).toBeEnabled();
    });
  });

  it.each([
    ['Cancel', async (user: ReturnType<typeof userEvent.setup>) => user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))],
    ['Close', async (user: ReturnType<typeof userEvent.setup>) => user.click(within(dialog()).getByRole('button', { name: 'Close' }))],
    ['Escape', () => {
      fireEvent(dialog(), new Event('cancel', { cancelable: true }));
      return Promise.resolve();
    }],
  ])('%s closes the Terms and leaves the box unticked', async (_name, close) => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    renderWithProviders(<Harness terms={termsFor('01JDOC00000000000000000001')} onValue={onValue} />);
    await openDialog(user);
    await waitFor(() => {
      expect(agreeButton()).toBeEnabled();
    });

    await close(user);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(checkbox()).not.toBeChecked();
    expect(onValue).not.toHaveBeenCalled();
  });

  it('ticks the box with the document id when I agree is pressed, and closes', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    renderWithProviders(<Harness terms={termsFor('01JDOC00000000000000000001')} onValue={onValue} />);
    await openDialog(user);
    await waitFor(() => {
      expect(agreeButton()).toBeEnabled();
    });

    await user.click(agreeButton());

    expect(onValue).toHaveBeenLastCalledWith('01JDOC00000000000000000001');
    expect(checkbox()).toBeChecked();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/you agreed to version 2026-10-01/i)).toBeInTheDocument();
  });

  it('can be unticked, and ticking again means reading and agreeing again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness terms={termsFor('01JDOC00000000000000000001')} />);
    await openDialog(user);
    await waitFor(() => {
      expect(agreeButton()).toBeEnabled();
    });
    await user.click(agreeButton());
    expect(checkbox()).toBeChecked();

    await user.click(checkbox());
    expect(checkbox()).not.toBeChecked();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(checkbox());
    expect(dialog()).toBeVisible();
    expect(checkbox()).not.toBeChecked();
  });

  it('clears an agreement when a different document replaces the one agreed to', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    renderWithProviders(
      <Harness
        terms={termsFor('01JDOC00000000000000000001')}
        replaceWith={termsFor('01JDOC00000000000000000002', '2026-11-01')}
        onValue={onValue}
      />,
    );
    await openDialog(user);
    await waitFor(() => {
      expect(agreeButton()).toBeEnabled();
    });
    await user.click(agreeButton());
    expect(checkbox()).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'New terms arrive' }));

    await waitFor(() => {
      expect(checkbox()).not.toBeChecked();
    });
    expect(onValue).toHaveBeenLastCalledWith(null);
  });

  it('cannot be ticked while the Terms have not loaded, and offers a retry when they fail', async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    renderWithProviders(
      <Harness terms={{ state: { status: 'error', error: new Error('offline') }, reload }} />,
    );

    expect(checkbox()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('says plainly when no Terms are published', () => {
    renderWithProviders(<Harness terms={{ state: { status: 'unavailable' }, reload: vi.fn() }} />);

    expect(checkbox()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/accounts cannot be opened right now/i);
  });
});

describe('atEnd', () => {
  it('treats text that fits as read, and a few pixels short of the bottom as the bottom', () => {
    expect(atEnd({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 })).toBe(true);
    expect(atEnd({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(true);
    expect(atEnd({ scrollTop: 795.5, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
    expect(atEnd({ scrollTop: 700, scrollHeight: 1000, clientHeight: 200 })).toBe(false);
  });
});
