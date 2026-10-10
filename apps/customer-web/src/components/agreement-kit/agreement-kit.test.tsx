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
import { SignInAgreements } from './SignInAgreements';
import { flushSignInAgreements, setPendingSignInAgreements, type SignInAgreementValue } from './sign-in-agreements';
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
    currentDocument: vi.fn().mockRejectedValue(new ApiLikeError('TERMS_DOCUMENT_UNAVAILABLE')),
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

describe("the Seller Hub's services agreement box", () => {
  const SELLER_TERMS = documentOf('01JSELLERTERMS000000000001', 'SELLER_TERMS', 'Seller Terms and Conditions');
  const SERVICES = documentOf('01JSERVICES000000000000001', 'SELLER_SERVICES_AGREEMENT', 'Seller Platform Services Agreement');

  function sellerStatus({ terms = false, services = false, privacy = false } = {}): AgreementStatus {
    return {
      scope: 'SELLER',
      terms: [
        { kind: 'PLATFORM_TERMS', current: TERMS, record: terms ? record(TERMS.document.id, 'TERMS_ACCEPTED') : null, unavailable: false },
        { kind: 'SELLER_TERMS', current: SELLER_TERMS, record: terms ? record(SELLER_TERMS.document.id, 'TERMS_ACCEPTED') : null, unavailable: false },
      ],
      services: [
        { kind: 'SELLER_SERVICES_AGREEMENT', current: SERVICES, record: services ? record(SERVICES.document.id, 'TERMS_ACCEPTED') : null, unavailable: false },
      ],
      privacy: { kind: 'PRIVACY_POLICY', current: PRIVACY, record: privacy ? record(PRIVACY.document.id, 'PRIVACY_NOTICE_ACKNOWLEDGED') : null, unavailable: false },
      termsComplete: terms,
      servicesComplete: services,
      privacyComplete: privacy,
      complete: terms && services && privacy,
    };
  }

  function SellerScreen({ client, initial }: { client: AgreementsClient; initial: AgreementStatus }): React.JSX.Element {
    const [status, setStatus] = useState(initial);
    return (
      <AgreementScreen
        client={client}
        scope="SELLER"
        status={status}
        onStatus={setStatus}
        onRefresh={() => Promise.resolve(status)}
        onContinue={vi.fn()}
        onSignOut={vi.fn()}
        marketplaceName="Test Market"
      />
    );
  }

  function renderSeller(client: AgreementsClient, initial = sellerStatus()) {
    return render(
      <I18nextProvider i18n={i18n}>
        <SellerScreen client={client} initial={initial} />
      </I18nextProvider>,
    );
  }

  const servicesBox = (): HTMLInputElement =>
    screen.getByRole('checkbox', { name: /I agree to the Seller Platform Services Agreement/ });

  it('is a third box, empty, with its own document - and a buyer never sees it', () => {
    renderSeller(fakeClient());
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(servicesBox()).not.toBeChecked();
    expect(termsBox()).not.toBeChecked();
    expect(screen.getByText('Continue becomes available once all three are saved.')).toBeInTheDocument();
    expect(screen.getByText(/It is not a signature by either party/)).toBeInTheDocument();
  });

  it('opens from the box or the name, and Cancel or Escape accepts nothing', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderSeller(client);

    await user.click(servicesBox());
    expect(dialog('Seller Platform Services Agreement')).toBeVisible();
    await user.click(within(dialog('Seller Platform Services Agreement')).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Seller Platform Services Agreement' }));
    expect(dialog('Seller Platform Services Agreement')).toBeVisible();
    await user.keyboard('{Escape}');

    expect(servicesBox()).not.toBeChecked();
    expect(client.record).not.toHaveBeenCalled();
  });

  it('is read on its own: reaching the end of the Terms does not unlock it', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderSeller(client);

    // The Terms fit, so their I agree is enabled at once...
    await user.click(termsBox());
    const termsAgree = within(dialog('Terms & Conditions')).getByRole('button', { name: 'I agree' });
    await waitFor(() => {
      expect(termsAgree).toBeEnabled();
    });
    await user.click(within(dialog('Terms & Conditions')).getByRole('button', { name: 'Cancel' }));

    // ...but a long services agreement starts at the top, disabled.
    const restore = tallTextEverywhere();
    try {
      await user.click(servicesBox());
      await nextFrame();
      const agree = within(dialog('Seller Platform Services Agreement')).getByRole('button', { name: 'I agree' });
      expect(agree).toBeDisabled();
    } finally {
      restore();
    }
    expect(client.record).not.toHaveBeenCalled();
  });

  it('ticks only its own box once the server saved it, and Continue waits for all three', async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      record: vi.fn().mockResolvedValue(sellerStatus({ services: true })),
    });
    renderSeller(client);

    await user.click(servicesBox());
    const agree = within(dialog('Seller Platform Services Agreement')).getByRole('button', { name: 'I agree' });
    await waitFor(() => {
      expect(agree).toBeEnabled();
    });
    await user.click(agree);

    expect(client.record).toHaveBeenCalledWith('SELLER', 'SERVICES', [SERVICES.document.id], 'en');
    await waitFor(() => {
      expect(servicesBox()).toBeChecked();
    });
    expect(termsBox()).not.toBeChecked();
    expect(privacyBox()).not.toBeChecked();
    expect(continueButton()).toBeDisabled();
  });

  it('can be read again once accepted without losing the tick, and unticking clears only it', async () => {
    const user = userEvent.setup();
    const client = fakeClient({ clear: vi.fn().mockResolvedValue(sellerStatus({ terms: true })) });
    renderSeller(client, sellerStatus({ terms: true, services: true }));

    await user.click(screen.getByRole('button', { name: 'Seller Platform Services Agreement' }));
    const box = dialog('Seller Platform Services Agreement');
    expect(within(box).queryByRole('button', { name: 'I agree' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(servicesBox()).toBeChecked();
    expect(client.clear).not.toHaveBeenCalled();

    await user.click(servicesBox());
    expect(client.clear).toHaveBeenCalledWith('SELLER', 'SERVICES', 'en');
    await waitFor(() => {
      expect(servicesBox()).not.toBeChecked();
    });
    expect(termsBox()).toBeChecked();
  });
});

describe('the company screen', () => {
  const B2B_TERMS = documentOf('01JB2BTERMS000000000000001', 'B2B_BUYER_TERMS', 'B2B Buyer Terms and Conditions');
  const B2B_SERVICES = documentOf('01JB2BSERVICES000000000001', 'B2B_BUYER_SERVICES_AGREEMENT', 'B2B Buyer Platform Services Agreement');

  function companyStatus({
    terms = false,
    services = false,
    privacy = false,
    canBind = true,
    byOtherMember = false,
  } = {}): AgreementStatus {
    return {
      scope: 'COMPANY_BUYER',
      terms: [{ kind: 'B2B_BUYER_TERMS', current: B2B_TERMS, record: terms ? record(B2B_TERMS.document.id, 'TERMS_ACCEPTED') : null, unavailable: false }],
      services: [
        {
          kind: 'B2B_BUYER_SERVICES_AGREEMENT',
          current: B2B_SERVICES,
          record: services ? { ...record(B2B_SERVICES.document.id, 'TERMS_ACCEPTED'), byOtherMember } : null,
          unavailable: false,
        },
      ],
      privacy: { kind: 'PRIVACY_POLICY', current: PRIVACY, record: privacy ? record(PRIVACY.document.id, 'PRIVACY_NOTICE_ACKNOWLEDGED') : null, unavailable: false },
      termsComplete: terms,
      servicesComplete: services,
      privacyComplete: privacy,
      complete: terms && services && privacy,
      company: { companyId: 'c1', companyName: 'Acme Imports', canBind },
      awaitingSignatory: !services && !canBind,
    };
  }

  function CompanyScreen({ client, initial }: { client: AgreementsClient; initial: AgreementStatus }): React.JSX.Element {
    const [status, setStatus] = useState(initial);
    return (
      <AgreementScreen
        client={client}
        scope="BUYER"
        status={status}
        onStatus={setStatus}
        onRefresh={() => Promise.resolve(status)}
        onContinue={vi.fn()}
        onSignOut={vi.fn()}
        marketplaceName="Test Market"
      />
    );
  }

  function renderCompany(client: AgreementsClient, initial = companyStatus()) {
    return render(
      <I18nextProvider i18n={i18n}>
        <CompanyScreen client={client} initial={initial} />
      </I18nextProvider>,
    );
  }

  const b2bTermsBox = (): HTMLInputElement =>
    screen.getByRole('checkbox', { name: /I agree to the B2B Buyer Terms & Conditions/ });
  const b2bServicesBox = (): HTMLInputElement =>
    screen.getByRole('checkbox', { name: /I agree to the B2B Buyer Platform Services Agreement/ });

  it('shows the three company documents, all empty, for the company the server named', () => {
    renderCompany(fakeClient());
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(b2bTermsBox()).not.toBeChecked();
    expect(b2bServicesBox()).not.toBeChecked();
    expect(privacyBox()).not.toBeChecked();
    expect(screen.getByText(/You are buying for Acme Imports./)).toBeInTheDocument();
    expect(screen.getByText(/It is not a signature by the marketplace/)).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
  });

  it('opens each document from its box, records only that box, and Cancel records nothing', async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      record: vi.fn().mockImplementation((_scope, role: string) =>
        Promise.resolve(companyStatus({ terms: role === 'TERMS', services: role === 'SERVICES', privacy: role === 'PRIVACY' })),
      ),
    });
    renderCompany(client);

    await user.click(b2bServicesBox());
    expect(b2bServicesBox()).not.toBeChecked();
    await user.click(within(dialog('B2B Buyer Platform Services Agreement')).getByRole('button', { name: 'Cancel' }));
    expect(client.record).not.toHaveBeenCalled();
    expect(b2bServicesBox()).not.toBeChecked();

    await user.click(b2bTermsBox());
    const agree = within(dialog('B2B Buyer Terms and Conditions')).getByRole('button', { name: 'I agree' });
    await waitFor(() => {
      expect(agree).toBeEnabled();
    });
    await user.click(agree);
    expect(client.record).toHaveBeenCalledTimes(1);
    expect(client.record).toHaveBeenCalledWith('BUYER', 'TERMS', [B2B_TERMS.document.id], 'en');
    await waitFor(() => {
      expect(b2bTermsBox()).toBeChecked();
    });
    expect(b2bServicesBox()).not.toBeChecked();
    expect(privacyBox()).not.toBeChecked();
  });

  it('asks for an authorised representative when this member cannot bind the company', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderCompany(client, companyStatus({ terms: true, privacy: true, canBind: false }));

    expect(b2bServicesBox()).toBeDisabled();
    expect(screen.getAllByText(/Authorised company representative required/).length).toBeGreaterThan(0);
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText(/You can continue once an owner or company admin/)).toBeInTheDocument();

    // The agreement can still be read, but not accepted.
    await user.click(screen.getByRole('button', { name: 'B2B Buyer Platform Services Agreement' }));
    const opened = dialog('B2B Buyer Platform Services Agreement');
    expect(within(opened).queryByRole('button', { name: 'I agree' })).not.toBeInTheDocument();
    expect(client.record).not.toHaveBeenCalled();
  });

  it('shows the company acceptance another member gave as done, and not this person’s to clear', () => {
    renderCompany(fakeClient(), companyStatus({ services: true, byOtherMember: true }));
    expect(b2bServicesBox()).toBeChecked();
    expect(b2bServicesBox()).toBeDisabled();
    expect(screen.getByText(/Accepted for Acme Imports by an authorised representative/)).toBeInTheDocument();
  });
});

describe('the consumer screen', () => {
  const B2C_TERMS = documentOf('01JB2CTERMS000000000000001', 'B2C_CONSUMER_TERMS', 'B2C Consumer Terms and Conditions');
  const B2C_SERVICES = documentOf('01JB2CSERVICES000000000001', 'B2C_PLATFORM_SERVICES_AGREEMENT', 'B2C Platform Services Agreement');

  function consumerStatus({ terms = false, services = false, privacy = false } = {}): AgreementStatus {
    return {
      scope: 'CONSUMER',
      terms: [{ kind: 'B2C_CONSUMER_TERMS', current: B2C_TERMS, record: terms ? record(B2C_TERMS.document.id, 'TERMS_ACCEPTED') : null, unavailable: false }],
      services: [{ kind: 'B2C_PLATFORM_SERVICES_AGREEMENT', current: B2C_SERVICES, record: services ? record(B2C_SERVICES.document.id, 'TERMS_ACCEPTED') : null, unavailable: false }],
      privacy: { kind: 'PRIVACY_POLICY', current: PRIVACY, record: privacy ? record(PRIVACY.document.id, 'PRIVACY_NOTICE_ACKNOWLEDGED') : null, unavailable: false },
      termsComplete: terms,
      servicesComplete: services,
      privacyComplete: privacy,
      complete: terms && services && privacy,
    };
  }

  function ConsumerScreen({ client, initial, onRefresh }: { client: AgreementsClient; initial: AgreementStatus; onRefresh?: (() => Promise<AgreementStatus | null>) | undefined }): React.JSX.Element {
    const [status, setStatus] = useState(initial);
    return (
      <AgreementScreen
        client={client}
        scope="BUYER"
        status={status}
        onStatus={setStatus}
        onRefresh={onRefresh ?? (() => Promise.resolve(status))}
        onContinue={vi.fn()}
        onSignOut={vi.fn()}
        marketplaceName="Test Market"
        supportHref="/support"
        ordersHref="/account/orders"
        legalHref="/legal"
      />
    );
  }

  function renderConsumer(client: AgreementsClient, initial = consumerStatus(), onRefresh?: () => Promise<AgreementStatus | null>) {
    return render(
      <I18nextProvider i18n={i18n}>
        <ConsumerScreen client={client} initial={initial} onRefresh={onRefresh} />
      </I18nextProvider>,
    );
  }

  const b2cTermsBox = (): HTMLInputElement => screen.getByRole('checkbox', { name: /I agree to the B2C Consumer Terms & Conditions/ });
  const b2cServicesBox = (): HTMLInputElement => screen.getByRole('checkbox', { name: /I agree to the B2C Platform Services Agreement/ });
  const consumerClient = (): AgreementsClient =>
    fakeClient({
      record: vi.fn().mockImplementation((_scope, role: string) =>
        Promise.resolve(consumerStatus({ terms: role === 'TERMS', services: role === 'SERVICES', privacy: role === 'PRIVACY' })),
      ),
    });

  it('shows the three consumer boxes, empty, in order - and nothing optional to tick', () => {
    renderConsumer(consumerClient());
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toEqual([b2cTermsBox(), privacyBox(), b2cServicesBox()]);
    for (const checkbox of boxes) expect(checkbox).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /marketing|AutoPay|recurring/i })).not.toBeInTheDocument();
    expect(screen.getByText(/To shop for yourself on Test Market/)).toBeInTheDocument();
    expect(screen.getByText(/does not give up your rights to cancel/)).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
  });

  it('keeps orders, returns, support and the legal documents a link away', () => {
    renderConsumer(consumerClient());
    expect(screen.getByRole('link', { name: 'Your orders and returns' })).toHaveAttribute('href', '/account/orders');
    expect(screen.getByRole('link', { name: 'Legal documents' })).toHaveAttribute('href', '/legal');
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support');
  });

  it('opens each document from its box; Cancel and Escape record nothing; I agree ticks only its box', async () => {
    const user = userEvent.setup();
    const client = consumerClient();
    renderConsumer(client);

    await user.click(b2cServicesBox());
    expect(b2cServicesBox()).not.toBeChecked();
    await user.click(within(dialog('B2C Platform Services Agreement')).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'B2C Consumer Terms & Conditions' }));
    expect(dialog('B2C Consumer Terms and Conditions')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(client.record).not.toHaveBeenCalled();
    expect(b2cTermsBox()).not.toBeChecked();

    await user.click(b2cTermsBox());
    const agree = within(dialog('B2C Consumer Terms and Conditions')).getByRole('button', { name: 'I agree' });
    await waitFor(() => {
      expect(agree).toBeEnabled();
    });
    await user.click(agree);
    expect(client.record).toHaveBeenCalledTimes(1);
    expect(client.record).toHaveBeenCalledWith('BUYER', 'TERMS', [B2C_TERMS.document.id], 'en');
    await waitFor(() => {
      expect(b2cTermsBox()).toBeChecked();
    });
    expect(privacyBox()).not.toBeChecked();
    expect(b2cServicesBox()).not.toBeChecked();
    expect(continueButton()).toBeDisabled();
  });

  it('asks the person to read again when the document changed while they read it', async () => {
    const user = userEvent.setup();
    const client = fakeClient({ record: vi.fn().mockRejectedValue(new ApiLikeError('AGREEMENT_DOCUMENT_NOT_APPLICABLE')) });
    const onRefresh = vi.fn().mockResolvedValue(consumerStatus());
    renderConsumer(client, consumerStatus(), onRefresh);
    await user.click(b2cServicesBox());
    const agree = within(dialog('B2C Platform Services Agreement')).getByRole('button', { name: 'I agree' });
    await waitFor(() => {
      expect(agree).toBeEnabled();
    });
    await user.click(agree);
    expect(await within(dialog('B2C Platform Services Agreement')).findByRole('alert')).toHaveTextContent(/new version was published/);
    expect(onRefresh).toHaveBeenCalled();
    expect(b2cServicesBox()).not.toBeChecked();
  });

  it('enables Continue only once all three are saved', () => {
    const first = renderConsumer(consumerClient(), consumerStatus({ terms: true, privacy: true }));
    expect(continueButton()).toBeDisabled();
    first.unmount();
    renderConsumer(consumerClient(), consumerStatus({ terms: true, privacy: true, services: true }));
    expect(continueButton()).toBeEnabled();
  });
});

describe('the boxes on a sign-in form', () => {
  const B2B_TERMS = documentOf('01JB2BTERMS000000000000001', 'B2B_BUYER_TERMS', 'B2B Buyer Terms and Conditions');
  const B2B_SERVICES = documentOf('01JB2BSERVICES000000000001', 'B2B_BUYER_SERVICES_AGREEMENT', 'B2B Buyer Platform Services Agreement');
  const BY_KIND: Record<string, CurrentAgreementDocument> = {
    B2B_BUYER_TERMS: B2B_TERMS,
    B2B_BUYER_SERVICES_AGREEMENT: B2B_SERVICES,
    PRIVACY_POLICY: PRIVACY,
    PLATFORM_TERMS: TERMS,
  };

  function signInClient(): AgreementsClient {
    return fakeClient({
      currentDocument: vi.fn().mockImplementation((kind: string) =>
        BY_KIND[kind] === undefined ? Promise.reject(new ApiLikeError('TERMS_DOCUMENT_UNAVAILABLE')) : Promise.resolve(BY_KIND[kind]),
      ),
    });
  }

  function Form({ client, scope, onComplete }: { client: AgreementsClient; scope: 'BUYER' | 'COMPANY_BUYER'; onComplete: (complete: boolean) => void }): React.JSX.Element {
    const [value, setValue] = useState<SignInAgreementValue>({});
    return <SignInAgreements client={client} scope={scope} value={value} onChange={setValue} onCompleteChange={onComplete} />;
  }

  function renderForm(scope: 'BUYER' | 'COMPANY_BUYER', client = signInClient()) {
    const onComplete = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <Form client={client} scope={scope} onComplete={onComplete} />
      </I18nextProvider>,
    );
    return { client, onComplete };
  }

  const box = (name: RegExp): HTMLInputElement => screen.getByRole('checkbox', { name });

  it('shows the company tab three one-line boxes, none ticked, and records nothing', async () => {
    const { client, onComplete } = renderForm('COMPANY_BUYER');
    await waitFor(() => {
      expect(box(/B2B Buyer Terms & Conditions/)).toBeEnabled();
    });
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(box(/Privacy Policy/)).not.toBeChecked();
    expect(box(/B2B Buyer Platform Services Agreement/)).not.toBeChecked();
    expect(onComplete).toHaveBeenLastCalledWith(false);
    expect(client.record).not.toHaveBeenCalled();
  });

  it('opens a document from its box, Cancel ticks nothing, and I agree ticks only that box', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderForm('COMPANY_BUYER');
    await waitFor(() => {
      expect(box(/B2B Buyer Terms & Conditions/)).toBeEnabled();
    });

    await user.click(box(/B2B Buyer Platform Services Agreement/));
    expect(box(/B2B Buyer Platform Services Agreement/)).not.toBeChecked();
    await user.click(within(dialog('B2B Buyer Platform Services Agreement')).getByRole('button', { name: 'Cancel' }));
    expect(box(/B2B Buyer Platform Services Agreement/)).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: 'B2B Buyer Terms & Conditions' }));
    const agree = within(dialog('B2B Buyer Terms and Conditions')).getByRole('button', { name: 'I agree' });
    await waitFor(() => {
      expect(agree).toBeEnabled();
    });
    await user.click(agree);
    expect(box(/B2B Buyer Terms & Conditions/)).toBeChecked();
    expect(box(/Privacy Policy/)).not.toBeChecked();
    expect(box(/B2B Buyer Platform Services Agreement/)).not.toBeChecked();
    expect(onComplete).toHaveBeenLastCalledWith(false);

    // Unticking just unticks.
    await user.click(box(/B2B Buyer Terms & Conditions/));
    expect(box(/B2B Buyer Terms & Conditions/)).not.toBeChecked();
  });

  const B2C_TERMS = documentOf('01JB2CTERMS000000000000001', 'B2C_CONSUMER_TERMS', 'B2C Consumer Terms and Conditions');
  const B2C_SERVICES = documentOf('01JB2CSERVICES000000000001', 'B2C_PLATFORM_SERVICES_AGREEMENT', 'B2C Platform Services Agreement');
  const clientWith = (documents: Record<string, CurrentAgreementDocument>): AgreementsClient =>
    fakeClient({
      currentDocument: vi.fn().mockImplementation((kind: string) =>
        documents[kind] === undefined ? Promise.reject(new ApiLikeError('TERMS_DOCUMENT_UNAVAILABLE')) : Promise.resolve(documents[kind]),
      ),
    });

  it('shows the individual tab the consumer boxes once every consumer document is published', async () => {
    renderForm('BUYER', clientWith({ ...BY_KIND, B2C_CONSUMER_TERMS: B2C_TERMS, B2C_PLATFORM_SERVICES_AGREEMENT: B2C_SERVICES }));
    await waitFor(() => {
      expect(box(/B2C Consumer Terms & Conditions/)).toBeEnabled();
    });
    expect(screen.getAllByRole('checkbox')).toEqual([
      box(/B2C Consumer Terms & Conditions/),
      box(/Privacy Policy/),
      box(/B2C Platform Services Agreement/),
    ]);
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /I agree to the Terms & Conditions/ })).not.toBeInTheDocument();
  });

  it('keeps the individual tab on the Terms of Use while any consumer document is missing', async () => {
    renderForm('BUYER', clientWith({ ...BY_KIND, B2C_CONSUMER_TERMS: B2C_TERMS }));
    await waitFor(() => {
      expect(termsBox()).toBeEnabled();
    });
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('is complete only once every box is agreed to', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderForm('BUYER');
    await waitFor(() => {
      expect(termsBox()).toBeEnabled();
    });
    for (const [opener, name, button] of [
      [termsBox, 'Gloviaa Terms of Use', 'I agree'],
      [privacyBox, 'Gloviaa Privacy Policy', 'I acknowledge'],
    ] as const) {
      await user.click(opener());
      const confirm = within(dialog(name)).getByRole('button', { name: button });
      await waitFor(() => {
        expect(confirm).toBeEnabled();
      });
      await user.click(confirm);
    }
    expect(onComplete).toHaveBeenLastCalledWith(true);
  });

  it('fails closed when the documents cannot be fetched, and can try again', async () => {
    const user = userEvent.setup();
    const client = signInClient();
    vi.mocked(client.currentDocument).mockRejectedValueOnce(new Error('offline'));
    const { onComplete } = renderForm('BUYER', client);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(termsBox()).toBeDisabled();
    expect(onComplete).not.toHaveBeenCalledWith(true);

    await user.click(retry);
    await waitFor(() => {
      expect(termsBox()).toBeEnabled();
    });
  });

  it('does not ask for a kind with nothing published, on the server’s word only', async () => {
    const client = fakeClient({
      currentDocument: vi.fn().mockImplementation((kind: string) =>
        kind === 'PRIVACY_POLICY' ? Promise.resolve(PRIVACY) : Promise.reject(new ApiLikeError('TERMS_DOCUMENT_UNAVAILABLE')),
      ),
    });
    renderForm('BUYER', client);
    await waitFor(() => {
      expect(privacyBox()).toBeEnabled();
    });
    expect(termsBox()).toBeDisabled();
  });

  it('records what was ticked once, after sign-in, for the matching screen only', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    setPendingSignInAgreements('COMPANY_BUYER', { TERMS: ['t1'], PRIVACY: ['p1'], SERVICES: ['s1'] });
    await flushSignInAgreements('SELLER', record);
    expect(record).not.toHaveBeenCalled();
    await flushSignInAgreements('BUYER', record);
    expect(record.mock.calls).toEqual([['TERMS', ['t1']], ['PRIVACY', ['p1']], ['SERVICES', ['s1']]]);
    await flushSignInAgreements('BUYER', record);
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('keeps going when one record is refused, leaving it for the screen after sign-in', async () => {
    const record = vi.fn().mockRejectedValueOnce(new ApiLikeError('COMPANY_SIGNATORY_REQUIRED')).mockResolvedValue(undefined);
    setPendingSignInAgreements('COMPANY_BUYER', { TERMS: ['t1'], PRIVACY: ['p1'] });
    await expect(flushSignInAgreements('BUYER', record)).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('makes a status request that starts during the recording wait for all of it', async () => {
    const recorded: string[] = [];
    const record = vi.fn(async (role: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      recorded.push(role);
    });
    setPendingSignInAgreements('CONSUMER', { TERMS: ['t1'], PRIVACY: ['p1'], SERVICES: ['s1'] });
    const first = flushSignInAgreements('BUYER', record);
    // A second request, as development's double effect or a refused call makes.
    await flushSignInAgreements('BUYER', record);
    expect(recorded).toEqual(['TERMS', 'PRIVACY', 'SERVICES']);
    await first;
    expect(record).toHaveBeenCalledTimes(3);
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

    // Continue asks the server again before it uncovers the page.
    expect(await screen.findByText('The page that was asked for')).toBeInTheDocument();
  });

  it('keeps the screen when the server cannot confirm Continue, and says so', async () => {
    const user = userEvent.setup();
    const client = fakeClient({ status: vi.fn().mockRejectedValue(new Error('offline')) });
    vi.mocked(client.status).mockResolvedValueOnce(statusOf({ terms: true }));
    vi.mocked(client.record).mockResolvedValue(statusOf({ terms: true, privacy: true }));
    renderGate(client);

    await screen.findByRole('heading', { name: 'Before you continue' });
    await user.click(privacyBox());
    const acknowledge = within(dialog('Gloviaa Privacy Policy')).getByRole('button', { name: 'I acknowledge' });
    await waitFor(() => {
      expect(acknowledge).toBeEnabled();
    });
    await user.click(acknowledge);
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(/could not confirm this with the server/)).toBeInTheDocument();
    expect(screen.queryByText('The page that was asked for')).not.toBeInTheDocument();
  });

  it('keeps the screen when the server says something is owed again at Continue', async () => {
    const user = userEvent.setup();
    const client = fakeClient({ status: vi.fn().mockResolvedValue(statusOf({ privacy: true })) });
    vi.mocked(client.status).mockResolvedValueOnce(statusOf({ terms: true }));
    vi.mocked(client.record).mockResolvedValue(statusOf({ terms: true, privacy: true }));
    renderGate(client);

    await screen.findByRole('heading', { name: 'Before you continue' });
    await user.click(privacyBox());
    const acknowledge = within(dialog('Gloviaa Privacy Policy')).getByRole('button', { name: 'I acknowledge' });
    await waitFor(() => {
      expect(acknowledge).toBeEnabled();
    });
    await user.click(acknowledge);
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

    // A new Terms version took effect meanwhile: its box is empty again.
    await waitFor(() => {
      expect(termsBox()).not.toBeChecked();
    });
    expect(screen.queryByText('The page that was asked for')).not.toBeInTheDocument();
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
