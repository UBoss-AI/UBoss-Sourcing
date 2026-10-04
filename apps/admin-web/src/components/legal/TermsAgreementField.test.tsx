/**
 * The staff terms checkbox and its dialog on the console sign-in.
 *
 * What is pinned here is who may tick the box: only I agree in the dialog.
 * Opening, scrolling, reaching the end, Cancel, Close, Escape and Enter leave
 * it empty, and unticking then ticking again means reading and agreeing again.
 * Plain assertions throughout: this app's test setup has no jest-dom matchers.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/config';
import type { CurrentLegalDocument } from '@/lib/legal-documents';
import type { CurrentTerms } from './useCurrentTerms';
import { TermsAgreementField } from './TermsAgreementField';
import { atEnd } from './useReadToEnd';

// jsdom implements no scrolling; the Modal's scroll lock restores a position.
window.scrollTo = () => undefined;

// jsdom has no <dialog> methods; the Modal only needs `open` toggled.
const dialogProto = HTMLDialogElement.prototype as HTMLDialogElement & {
  showModal?: () => void;
  close?: () => void;
};
if (typeof dialogProto.showModal !== 'function') {
  dialogProto.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
}
if (typeof dialogProto.close !== 'function') {
  dialogProto.close = function close(this: HTMLDialogElement): void {
    this.open = false;
  };
}

function termsFor(id: string, version = '2026-10-01'): CurrentTerms {
  const current: CurrentLegalDocument = {
    document: {
      id,
      kind: 'STAFF_TERMS',
      version,
      locale: 'en',
      title: 'Staff Terms',
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

function renderField(element: React.JSX.Element): void {
  render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

const checkbox = (): HTMLInputElement =>
  screen.getByRole('checkbox', { name: /staff terms/i });
const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Staff Terms' });
const queryDialog = (): HTMLElement | null => screen.queryByRole('dialog');
const agreeButton = (): HTMLButtonElement =>
  within(dialog()).getByRole('button', { name: 'I agree' });

function openDialog(): void {
  fireEvent.click(checkbox());
  expect(dialog()).toBeTruthy();
}

async function waitForAgreeEnabled(): Promise<void> {
  await waitFor(() => {
    expect(agreeButton().disabled).toBe(false);
  });
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('TermsAgreementField', () => {
  it('starts unticked, and ticking it opens the terms instead of ticking it', () => {
    renderField(<Harness terms={termsFor('01JDOC00000000000000000001')} />);
    expect(checkbox().checked).toBe(false);
    openDialog();
    expect(checkbox().checked).toBe(false);
  });

  it('opens the terms from the words in the sentence, and with Enter on the box', () => {
    renderField(<Harness terms={termsFor('01JDOC00000000000000000001')} />);

    fireEvent.click(screen.getByRole('button', { name: 'Staff Terms' }));
    expect(dialog()).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(queryDialog()).toBeNull();

    fireEvent.keyDown(checkbox(), { key: 'Enter' });
    expect(dialog()).toBeTruthy();
    expect(checkbox().checked).toBe(false);
  });

  it('keeps I agree disabled until the end of the text is reached', async () => {
    renderField(<Harness terms={termsFor('01JDOC00000000000000000001')} />);
    openDialog();

    const region = within(dialog()).getByRole('region');
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 1000 });
    fireEvent.scroll(region);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(agreeButton().disabled).toBe(true);
    expect(within(dialog()).getByRole('status').textContent).toBe(
      'Read all terms before accepting.',
    );

    region.scrollTop = 500;
    fireEvent.scroll(region);
    expect(agreeButton().disabled).toBe(true);

    region.scrollTop = 795;
    fireEvent.scroll(region);
    await waitForAgreeEnabled();

    // Back up to re-read a clause: still enabled, and still nothing ticked.
    region.scrollTop = 0;
    fireEvent.scroll(region);
    expect(agreeButton().disabled).toBe(false);
    expect(checkbox().checked).toBe(false);
  });

  it('enables I agree at once when the whole text fits', async () => {
    renderField(<Harness terms={termsFor('01JDOC00000000000000000001')} />);
    openDialog();
    // jsdom lays nothing out: scrollHeight equals clientHeight, text that fits.
    await waitForAgreeEnabled();
  });

  it.each([
    [
      'Cancel',
      () => {
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
      },
    ],
    [
      'Close',
      () => {
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
      },
    ],
    [
      'Escape',
      () => {
        fireEvent(dialog(), new Event('cancel', { cancelable: true }));
      },
    ],
  ])('%s closes the terms and leaves the box unticked', async (_name, close) => {
    const onValue = vi.fn();
    renderField(<Harness terms={termsFor('01JDOC00000000000000000001')} onValue={onValue} />);
    openDialog();
    await waitForAgreeEnabled();

    close();

    expect(queryDialog()).toBeNull();
    expect(checkbox().checked).toBe(false);
    expect(onValue).not.toHaveBeenCalled();
  });

  it('ticks the box with the document id when I agree is pressed, and closes', async () => {
    const onValue = vi.fn();
    renderField(<Harness terms={termsFor('01JDOC00000000000000000001')} onValue={onValue} />);
    openDialog();
    await waitForAgreeEnabled();

    fireEvent.click(agreeButton());

    expect(onValue).toHaveBeenLastCalledWith('01JDOC00000000000000000001');
    expect(checkbox().checked).toBe(true);
    expect(queryDialog()).toBeNull();
  });

  it('can be unticked, and ticking again means reading and agreeing again', async () => {
    renderField(<Harness terms={termsFor('01JDOC00000000000000000001')} />);
    openDialog();
    await waitForAgreeEnabled();
    fireEvent.click(agreeButton());
    expect(checkbox().checked).toBe(true);

    fireEvent.click(checkbox());
    expect(checkbox().checked).toBe(false);
    expect(queryDialog()).toBeNull();

    fireEvent.click(checkbox());
    expect(dialog()).toBeTruthy();
    expect(checkbox().checked).toBe(false);
  });

  it('clears an agreement when a different document replaces the one agreed to', async () => {
    const onValue = vi.fn();
    renderField(
      <Harness
        terms={termsFor('01JDOC00000000000000000001')}
        replaceWith={termsFor('01JDOC00000000000000000002', '2026-11-01')}
        onValue={onValue}
      />,
    );
    openDialog();
    await waitForAgreeEnabled();
    fireEvent.click(agreeButton());
    expect(checkbox().checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'New terms arrive' }));

    await waitFor(() => {
      expect(checkbox().checked).toBe(false);
    });
    expect(onValue).toHaveBeenLastCalledWith(null);
  });

  it('says the agreement is asked again on every sign-in once given', async () => {
    renderField(<Harness terms={termsFor('01JDOC00000000000000000001')} />);
    openDialog();
    await waitForAgreeEnabled();
    fireEvent.click(agreeButton());
    expect(screen.getByRole('status').textContent).toBe(
      'You agreed to version 2026-10-01. You agree again each time you sign in.',
    );
  });

  it('cannot be ticked while the terms are loading, and says so', () => {
    renderField(<Harness terms={{ state: { status: 'loading' }, reload: vi.fn() }} />);
    expect(checkbox().disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Loading the terms…');
  });
});

describe('atEnd', () => {
  it('treats text that fits as read, and a few pixels short of the bottom as the bottom', () => {
    expect(atEnd({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 })).toBe(true);
    expect(atEnd({ scrollTop: 795.5, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
    expect(atEnd({ scrollTop: 700, scrollHeight: 1000, clientHeight: 200 })).toBe(false);
  });
});
