/**
 * The agreement screen and its dialog. The same file in all four apps.
 *
 * What is pinned here is who may tick a box: only the server, after "I agree"
 * or "I acknowledge" saved a record. Opening a document, scrolling it,
 * reaching the end, Cancel, Close, Escape, Space and Enter must all leave the
 * boxes as they were; a failed save leaves the box empty; a version published
 * while the dialog is open replaces the text and starts the reading over.
 */
// Explicit, because not every app's test setup registers these matchers.
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/config';
import { AgreementGate } from './AgreementGate';
import { AgreementScreen } from './AgreementScreen';
import type { AgreementsClient, AgreementStatus, CurrentAgreementDocument } from './types';
import { atEnd } from './useReadToEnd';

// jsdom has no <dialog> behaviour; the app's own setup may already add it.
const dialogProto = HTMLDialogElement.prototype as unknown as {
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

function documentOf(id: string, kind: string, title: string, version = '2026-11-01'): CurrentAgreementDocument {
  return {
    document: {
      id,
      kind,
      version,
      locale: 'en',
      title,
      body: '## Part A - Common\n## A1. One\nFirst clause.\n\n- a point\n\n## A2. Two\nSecond clause.',
      changeSummary: null,
      effectiveAt: '2026-11-01T00:00:00.000Z',
      publishedAt: '2026-10-30T00:00:00.000Z',
      contentSha256: 'c'.repeat(64),
    },
    requestedLocale: 'en',
    isFallback: false,
  };
}

const TERMS = documentOf('01JTERMS000000000000000001', 'PLATFORM_TERMS', 'Gloviaa Terms of Use');
const TERMS_V2 = documentOf('01JTERMS000000000000000002', 'PLATFORM_TERMS', 'Gloviaa Terms of Use, version 2', '2026-12-01');
const PRIVACY = documentOf('01JPRIVACY0000000000000001', 'PRIVACY_POLICY', 'Gloviaa Privacy Policy');

function record(documentId: string, action: 'TERMS_ACCEPTED' | 'PRIVACY_NOTICE_ACKNOWLEDGED') {
  return { recordId: `r-${documentId}`, documentId, version: '2026-11-01', locale: 'en', action, recordedAt: '2026-11-02T10:00:00.000Z' };
}

function statusOf({ terms = false, privacy = false, termsDocument = TERMS } = {}): AgreementStatus {
  return {
    scope: 'BUYER',
    terms: [{ kind: 'PLATFORM_TERMS', current: termsDocument, record: terms ? record(termsDocument.document.id, 'TERMS_ACCEPTED') : null, unavailable: false }],
    privacy: { kind: 'PRIVACY_POLICY', current: PRIVACY, record: privacy ? record(PRIVACY.document.id, 'PRIVACY_NOTICE_ACKNOWLEDGED') : null, unavailable: false },
    termsComplete: terms,
    privacyComplete: privacy,
    complete: terms && privacy,
  };
}

class ApiLikeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function fakeClient(overrides: Partial<AgreementsClient> = {}): AgreementsClient {
  return {
    status: vi.fn().mockResolvedValue(statusOf()),
    record: vi.fn().mockImplementation((_scope, role: string) =>
      Promise.resolve(statusOf({ terms: role === 'TERMS', privacy: role === 'PRIVACY' })),
    ),
    clear: vi.fn().mockResolvedValue(statusOf()),
    history: vi.fn().mockResolvedValue([]),
    pdfUrl: (id) => `/pdf/${id}`,
    pageUrl: () => null,
    onRequired: () => () => undefined,
    errorCode: (error) => (error instanceof ApiLikeError ? error.code : null),
    ...overrides,
  };
}

function Screen({ client, initial = statusOf(), onContinue = vi.fn(), refreshTo }: {
  client: AgreementsClient;
  initial?: AgreementStatus;
  onContinue?: () => void;
  refreshTo?: AgreementStatus;
}): React.JSX.Element {
  // The gate's own state handling, cut down: the server's answer replaces the old one.
  const [status, setStatus] = useState(initial);
  return (
    <AgreementScreen
      client={client}
      scope="BUYER"
      status={status}
      onStatus={setStatus}
      onRefresh={() => {
        const next = refreshTo ?? status;
        setStatus(next);
        return Promise.resolve(next);
      }}
      onContinue={onContinue}
      onSignOut={vi.fn()}
      marketplaceName="Test Market"
    />
  );
}

function renderScreen(props: Parameters<typeof Screen>[0]) {
  return render(
    <I18nextProvider i18n={i18n}>
      <Screen {...props} />
    </I18nextProvider>,
  );
}

const termsBox = (): HTMLInputElement => screen.getByRole('checkbox', { name: /I agree to the Terms & Conditions/ });
const privacyBox = (): HTMLInputElement => screen.getByRole('checkbox', { name: /I acknowledge that I have read the Privacy Policy/ });
const dialog = (name: string | RegExp): HTMLElement => screen.getByRole('dialog', { name });
const continueButton = (): HTMLElement => screen.getByRole('button', { name: 'Continue' });

/** Every element reports text taller than its box until `restore` is called. */
function tallTextEverywhere(): () => void {
  const proto = HTMLElement.prototype;
  const saved = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 200 });
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 1000 });
  return () => {
    delete (proto as unknown as Record<string, unknown>)['scrollHeight'];
    if (saved !== undefined) Object.defineProperty(proto, 'clientHeight', saved);
    else delete (proto as unknown as Record<string, unknown>)['clientHeight'];
  };
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

beforeEach(async () => {
  // The Modal's scroll lock restores the page position; jsdom has no scrolling.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  await i18n.changeLanguage('en');
});

describe('the agreement screen', () => {
  it('shows exactly two boxes, both empty, and Continue disabled', () => {
    renderScreen({ client: fakeClient() });
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(termsBox()).not.toBeChecked();
    expect(privacyBox()).not.toBeChecked();
    expect(continueButton()).toBeDisabled();
  });

  it('opens the right document from the box, the sentence and the name - and ticks nothing', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderScreen({ client });

    await user.click(termsBox());
    expect(dialog('Gloviaa Terms of Use')).toBeVisible();
    expect(termsBox()).not.toBeChecked();
    await user.click(within(dialog('Gloviaa Terms of Use')).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Privacy Policy' }));
    expect(dialog('Gloviaa Privacy Policy')).toBeVisible();
    expect(privacyBox()).not.toBeChecked();
    await user.click(within(dialog('Gloviaa Privacy Policy')).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByText(/I acknowledge that I have read the/));
    expect(dialog('Gloviaa Privacy Policy')).toBeVisible();
    expect(client.record).not.toHaveBeenCalled();
  });

  it('opens with Enter and Space on the box, and ticks nothing', async () => {
    const user = userEvent.setup();
    renderScreen({ client: fakeClient() });

    termsBox().focus();
    await user.keyboard('{Enter}');
    expect(dialog('Gloviaa Terms of Use')).toBeVisible();
    await user.click(within(dialog('Gloviaa Terms of Use')).getByRole('button', { name: 'Cancel' }));

    termsBox().focus();
    await user.keyboard(' ');
    expect(dialog('Gloviaa Terms of Use')).toBeVisible();
    expect(termsBox()).not.toBeChecked();
  });

  it('keeps I agree disabled until the end of the text, says why, and records nothing by scrolling', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    const restore = tallTextEverywhere();
    try {
      renderScreen({ client });
      await user.click(termsBox());
      await nextFrame();
    } finally {
      restore();
    }

    const box = dialog('Gloviaa Terms of Use');
    const agree = within(box).getByRole('button', { name: 'I agree' });
    const region = within(box).getByRole('region', { name: /Full text of/ });
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 1000 });
    fireEvent.scroll(region);
    expect(agree).toBeDisabled();
    expect(agree).toHaveAccessibleDescription('Scroll to the end to enable acknowledgment.');

    region.scrollTop = 500;
    fireEvent.scroll(region);
    expect(agree).toBeDisabled();

    region.scrollTop = 795;
    fireEvent.scroll(region);
    await waitFor(() => {
      expect(agree).toBeEnabled();
    });
    expect(termsBox()).not.toBeChecked();
    expect(client.record).not.toHaveBeenCalled();
  });

  it('enables the button at once when the whole text fits', async () => {
    const user = userEvent.setup();
    renderScreen({ client: fakeClient() });
    await user.click(termsBox());
    // jsdom lays nothing out: scrollHeight equals clientHeight, text that fits.
    await waitFor(() => {
      expect(within(dialog('Gloviaa Terms of Use')).getByRole('button', { name: 'I agree' })).toBeEnabled();
    });
  });

  it.each([
    ['Cancel', async (user: ReturnType<typeof userEvent.setup>, box: HTMLElement) => user.click(within(box).getByRole('button', { name: 'Cancel' }))],
    ['Close', async (user: ReturnType<typeof userEvent.setup>, box: HTMLElement) => user.click(within(box).getByRole('button', { name: /close/i }))],
    ['Escape', (_user: ReturnType<typeof userEvent.setup>, box: HTMLElement) => {
      fireEvent(box, new Event('cancel', { cancelable: true }));
      return Promise.resolve();
    }],
  ])('%s closes the document and records nothing', async (_name, close) => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderScreen({ client });
    await user.click(termsBox());
    const box = dialog('Gloviaa Terms of Use');
    await waitFor(() => {
      expect(within(box).getByRole('button', { name: 'I agree' })).toBeEnabled();
    });

    await close(user, box);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(termsBox()).not.toBeChecked();
    expect(client.record).not.toHaveBeenCalled();
  });

  it('ticks only the Terms box when the Terms are agreed, and only once the server saved it', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderScreen({ client });
    await user.click(termsBox());
    const agree = within(dialog('Gloviaa Terms of Use')).getByRole('button', { name: 'I agree' });
    await waitFor(() => {
      expect(agree).toBeEnabled();
    });

    await user.click(agree);

    expect(client.record).toHaveBeenCalledTimes(1);
    expect(client.record).toHaveBeenCalledWith('BUYER', 'TERMS', [TERMS.document.id], 'en');
    await waitFor(() => {
      expect(termsBox()).toBeChecked();
    });
    expect(privacyBox()).not.toBeChecked();
    expect(continueButton()).toBeDisabled();
  });

  it('leaves the box empty and says so when the save fails, and saves once for a double click', async () => {
    const user = userEvent.setup();
    let reject: (error: Error) => void = () => undefined;
    const client = fakeClient({
      record: vi.fn().mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; })),
    });
    renderScreen({ client });
    await user.click(privacyBox());
    const box = dialog('Gloviaa Privacy Policy');
    const acknowledge = within(box).getByRole('button', { name: 'I acknowledge' });
    await waitFor(() => {
      expect(acknowledge).toBeEnabled();
    });

    await user.click(acknowledge);
    await user.click(within(box).getByRole('button', { name: /Saving/ }));
    expect(client.record).toHaveBeenCalledTimes(1);

    await act(async () => {
      reject(new ApiLikeError('INTERNAL_ERROR'));
      await Promise.resolve();
    });

    expect(await within(box).findByRole('alert')).toHaveTextContent(/was not saved/);
    expect(privacyBox()).not.toBeChecked();
  });

  it('replaces the text and starts over when a new version was published while reading', async () => {
    const user = userEvent.setup();
    const client = fakeClient({ record: vi.fn().mockRejectedValue(new ApiLikeError('TERMS_VERSION_OUTDATED')) });
    renderScreen({ client, refreshTo: statusOf({ termsDocument: TERMS_V2 }) });
    await user.click(termsBox());
    const agree = within(dialog('Gloviaa Terms of Use')).getByRole('button', { name: 'I agree' });
    await waitFor(() => {
      expect(agree).toBeEnabled();
    });

    await user.click(agree);

    const updated = await screen.findByRole('dialog', { name: 'Gloviaa Terms of Use, version 2' });
    expect(within(updated).getByRole('alert')).toHaveTextContent(/new version was published/);
    expect(termsBox()).not.toBeChecked();
  });

  it('enables Continue only when both are saved, and Continue is what leaves', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    renderScreen({ client: fakeClient(), initial: statusOf({ terms: true, privacy: true }), onContinue });

    expect(termsBox()).toBeChecked();
    expect(privacyBox()).toBeChecked();
    await user.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('clears one box before Continue, and only that one', async () => {
    const user = userEvent.setup();
    const client = fakeClient({ clear: vi.fn().mockResolvedValue(statusOf({ terms: true })) });
    renderScreen({ client, initial: statusOf({ terms: true, privacy: true }) });

    await user.click(privacyBox());

    expect(client.clear).toHaveBeenCalledWith('BUYER', 'PRIVACY', 'en');
    await waitFor(() => {
      expect(privacyBox()).not.toBeChecked();
    });
    expect(termsBox()).toBeChecked();
    expect(continueButton()).toBeDisabled();
  });

  it('lets a document already accepted be read again, with no button to accept it twice', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderScreen({ client, initial: statusOf({ terms: true }) });

    await user.click(screen.getByRole('button', { name: 'Terms & Conditions' }));

    const box = dialog('Gloviaa Terms of Use');
    expect(within(box).queryByRole('button', { name: 'I agree' })).not.toBeInTheDocument();
    expect(within(box).getByRole('status')).toHaveTextContent(/Recorded on/);
    expect(client.clear).not.toHaveBeenCalled();
  });

  it('never enables acceptance for a document that failed to load', async () => {
    const user = userEvent.setup();
    const empty = statusOf();
    empty.privacy = { ...empty.privacy, current: null };
    renderScreen({ client: fakeClient(), initial: empty });

    await user.click(screen.getByRole('button', { name: 'Privacy Policy' }));
    const box = screen.getByRole('dialog');
    expect(within(box).getByRole('button', { name: 'I acknowledge' })).toBeDisabled();
    expect(within(box).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('the gate', () => {
  function renderGate(client: AgreementsClient, props: Partial<Parameters<typeof AgreementGate>[0]> = {}) {
    return render(
      <I18nextProvider i18n={i18n}>
        <AgreementGate client={client} scope="BUYER" enabled marketplaceName="Test Market" onSignOut={vi.fn()} {...props}>
          <p>The page that was asked for</p>
        </AgreementGate>
      </I18nextProvider>,
    );
  }

  it('covers the page while something is owed, and Continue uncovers the same page', async () => {
    const user = userEvent.setup();
    const client = fakeClient({ status: vi.fn().mockResolvedValue(statusOf({ terms: true, privacy: true })) });
    // Owed first; both saved by the time the screen is answered.
    vi.mocked(client.status).mockResolvedValueOnce(statusOf({ terms: true }));
    vi.mocked(client.record).mockResolvedValue(statusOf({ terms: true, privacy: true }));
    renderGate(client);

    expect(await screen.findByRole('heading', { name: 'Before you continue' })).toBeInTheDocument();
    expect(screen.queryByText('The page that was asked for')).not.toBeInTheDocument();

    await user.click(privacyBox());
    const acknowledge = within(dialog('Gloviaa Privacy Policy')).getByRole('button', { name: 'I acknowledge' });
    await waitFor(() => {
      expect(acknowledge).toBeEnabled();
    });
    await user.click(acknowledge);
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

    expect(screen.getByText('The page that was asked for')).toBeInTheDocument();
  });

  it('shows the page straight away to somebody who owes nothing', async () => {
    renderGate(fakeClient({ status: vi.fn().mockResolvedValue(statusOf({ terms: true, privacy: true })) }));
    expect(await screen.findByText('The page that was asked for')).toBeInTheDocument();
  });

  it('asks again when the server refuses a request for want of an agreement', async () => {
    let announce: () => void = () => undefined;
    const client = fakeClient({
      status: vi.fn().mockResolvedValueOnce(statusOf({ terms: true, privacy: true })).mockResolvedValue(statusOf({ terms: true })),
      onRequired: (listener) => {
        announce = listener;
        return () => undefined;
      },
    });
    renderGate(client);
    expect(await screen.findByText('The page that was asked for')).toBeInTheDocument();

    act(() => {
      announce();
    });

    expect(await screen.findByRole('heading', { name: 'Before you continue' })).toBeInTheDocument();
  });

  it('fails closed, with a way out, when the server cannot be asked', async () => {
    const onSignOut = vi.fn();
    const user = userEvent.setup();
    renderGate(fakeClient({ status: vi.fn().mockRejectedValue(new Error('offline')) }), { onSignOut });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('The page that was asked for')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalled();
  });

  it('stays out of the way for pages reachable before agreement, for guests, and where it does not apply', async () => {
    const owes = (): AgreementsClient => fakeClient();
    const { unmount } = renderGate(owes(), { bypass: true });
    expect(screen.getByText('The page that was asked for')).toBeInTheDocument();
    unmount();

    const guest = renderGate(owes(), { enabled: false });
    expect(screen.getByText('The page that was asked for')).toBeInTheDocument();
    guest.unmount();

    renderGate(fakeClient({ status: vi.fn().mockRejectedValue(new ApiLikeError('SELLER_ACCOUNT_REQUIRED')) }), {
      notApplicable: (error) => error instanceof ApiLikeError && error.code === 'SELLER_ACCOUNT_REQUIRED',
    });
    expect(await screen.findByText('The page that was asked for')).toBeInTheDocument();
  });
});

describe('atEnd', () => {
  it('treats text that fits as read, and a few pixels short of the bottom as the bottom', () => {
    expect(atEnd({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 })).toBe(true);
    expect(atEnd({ scrollTop: 795.5, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
    expect(atEnd({ scrollTop: 700, scrollHeight: 1000, clientHeight: 200 })).toBe(false);
  });
});
