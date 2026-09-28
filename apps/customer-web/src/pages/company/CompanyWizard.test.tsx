/**
 * The company application wizard, as a company buyer walks it.
 *
 * What is pinned down here is what the storefront decides for itself: the six
 * steps and their order, which step a draft opens on, the representative's
 * questions, that only the identifiers the SERVER lists for a country are
 * drawn, that a refused save keeps the person on the step with what they
 * typed, and that an obviously unusable file is refused before it is sent.
 *
 * What is required, and whether a file is really a PDF, are the server's -
 * those are tested in the backend's integration suite.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import type { CompanyApplication } from '@/lib/buyer-companies';
import { localFileProblem, stepOfField } from './application-logic';
import { CompanyWizard } from './CompanyWizard';

const fetchMock = vi.fn();

interface FakeXhrHandle {
  instance: {
    withCredentials: boolean;
    status: number;
    responseText: string;
    upload: { onprogress: ((event: ProgressEvent) => void) | null };
    onload: (() => void) | null;
  } | null;
  progress: (fraction: number) => void;
  finish: () => void;
}

/**
 * An XMLHttpRequest the test drives by hand. Uploads go through XHR rather
 * than fetch because only XHR reports upload progress.
 */
function installFakeXhr(answer: { status: number; body: unknown }): FakeXhrHandle {
  const handle: FakeXhrHandle = {
    instance: null,
    progress: (fraction) => {
      handle.instance?.upload.onprogress?.({ lengthComputable: true, loaded: fraction * 100, total: 100 } as ProgressEvent);
    },
    finish: () => {
      const xhr = handle.instance;
      if (xhr === null) throw new Error('nothing was sent');
      xhr.status = answer.status;
      xhr.responseText = JSON.stringify(answer.body);
      xhr.onload?.();
    },
  };
  class FakeXhr {
    status = 0;
    responseText = '';
    withCredentials = false;
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open(): void {
      // Nothing to open.
    }
    setRequestHeader(): void {
      // Headers are not inspected here.
    }
    getAllResponseHeaders(): string {
      return 'content-type: application/json';
    }
    abort(): void {
      // Never aborted in these tests.
    }
    send(): void {
      handle.instance = this;
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return handle;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function application(overrides: Partial<CompanyApplication> = {}): CompanyApplication {
  return {
    id: '01TESTCOMPANYAPPLICATION00',
    reference: 'BC-TEST0001',
    status: 'DRAFT',
    version: 0,
    statusReason: null,
    statusReasonCode: null,
    resubmissionAllowed: true,
    role: 'OWNER',
    canManage: true,
    business: {
      legalName: null,
      tradingName: null,
      entityType: null,
      registrationCountry: null,
      registrationNumber: null,
      incorporationDate: null,
      industry: null,
      website: null,
      businessEmail: 'buyer@example.test',
      businessEmailVerified: true,
      businessPhone: null,
    },
    applicant: {
      fullName: 'Asha Menon',
      phone: '+919876543210',
      jobTitle: null,
      relationship: null,
      authorityConfirmed: false,
    },
    prefilledFromSeller: false,
    addresses: [],
    identifiers: [],
    procurement: null,
    requirements: {
      register: 'LOCAL',
      incorporationDateRequired: false,
      identifiers: [],
      documents: [
        { kinds: ['CERTIFICATE_OF_INCORPORATION', 'REGISTRY_EXTRACT'], required: true, purpose: 'PROVES_EXISTENCE' },
        { kinds: ['AUTHORIZATION_LETTER'], required: false, purpose: 'PROVES_AUTHORITY' },
        { kinds: ['PROOF_OF_REGISTERED_ADDRESS'], required: false, purpose: 'PROVES_ADDRESS' },
        { kinds: ['BUSINESS_LICENCE'], required: false, purpose: 'PROVES_LICENCE' },
      ],
    },
    problems: [
      { field: 'legalName', code: 'REQUIRED' },
      { field: 'applicantJobTitle', code: 'REQUIRED' },
      { field: 'applicantRelationship', code: 'REQUIRED' },
    ],
    documents: [],
    infoRequests: [],
    timeline: [],
    actions: { edit: true, submit: true, resubmit: false, reopen: false, respond: false, verifyEmail: false },
    createdAt: '2026-09-28T09:00:00.000Z',
    submittedAt: null,
    firstSubmittedAt: null,
    approvedAt: null,
    rejectedAt: null,
    suspendedAt: null,
    ...overrides,
  };
}

const STEP_NAMES = [
  /account and representative/i,
  /business details/i,
  /registration and tax details/i,
  /^addresses/i,
  /verification documents/i,
  /review and submit/i,
];

/**
 * The stepper card's buttons. The indicator draws two layouts - the numbered
 * row for phones and the card from `lg` up - and CSS shows exactly one of
 * them. jsdom applies no CSS, so both are here; the card is the second list.
 */
function stepButtons(): HTMLElement[] {
  const nav = screen.getByRole('navigation', { name: /steps/i });
  const [, card] = within(nav).getAllByRole('list');
  return within(card as HTMLElement).getAllByRole('button');
}

describe('CompanyWizard - the six steps', () => {
  it('shows the six business steps in order, with the progress stated', () => {
    renderWithProviders(<CompanyWizard application={application()} />);

    const buttons = stepButtons();
    expect(buttons).toHaveLength(6);
    buttons.forEach((button, index) => {
      expect(button).toHaveAccessibleName(STEP_NAMES[index]);
    });
    expect(screen.getAllByText(/step 1 of 6/i).length).toBeGreaterThan(0);
  });

  it('says in words what state each step is in, not only with a colour', () => {
    renderWithProviders(<CompanyWizard application={application()} />);

    const [first, second, third] = stepButtons();
    expect(first).toHaveTextContent(/in progress/i);
    // The server lists something missing on the business step.
    expect(second).toHaveTextContent(/needs attention/i);
    // Nothing missing, but never saved either: not "Complete" just for its position.
    expect(third).toHaveTextContent(/not started/i);
    expect(screen.getByText(/0 of 6 steps complete/i)).toBeInTheDocument();
  });

  it('calls a step complete once it is saved with nothing missing', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        application({
          applicant: { fullName: 'Asha Menon', phone: '+919876543210', jobTitle: 'Buyer', relationship: 'EMPLOYEE', authorityConfirmed: true },
          problems: [{ field: 'legalName', code: 'REQUIRED' }],
        }),
      ),
    );
    const answered = application({
      applicant: { fullName: 'Asha Menon', phone: '+919876543210', jobTitle: 'Buyer', relationship: 'EMPLOYEE', authorityConfirmed: true },
      problems: [{ field: 'legalName', code: 'REQUIRED' }],
    });
    // Holds the application the way the page's query cache does, so the
    // server's answer can be handed back without re-rendering the providers.
    let replace: (next: CompanyApplication) => void = () => undefined;
    function Holder(): React.JSX.Element {
      const [current, setCurrent] = useState(application());
      replace = setCurrent;
      return <CompanyWizard application={current} />;
    }
    renderWithProviders(<Holder />);
    await user.type(screen.getByLabelText(/job title/i), 'Buyer');
    await user.selectOptions(screen.getByLabelText(/relationship to the business/i), 'EMPLOYEE');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /save and continue/i }));
    await screen.findByRole('heading', { level: 2, name: /business details/i });
    act(() => {
      replace(answered);
    });
    expect(stepButtons()[0]).toHaveTextContent(/complete/i);
    expect(screen.getByText(/1 of 6 steps complete/i)).toBeInTheDocument();
  });

  it('opens a fresh draft on the earliest step with something missing, not the first problem listed', () => {
    // The server lists the business problem first; the representative step
    // comes first in the walk, so that is where the draft must open.
    renderWithProviders(<CompanyWizard application={application()} />);

    expect(stepButtons()[0]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('heading', { level: 2, name: /account and representative/i })).toBeInTheDocument();
  });

  it('maps every problem field to the step it is answered on', () => {
    expect(stepOfField('applicantRelationship')).toBe('applicant');
    expect(stepOfField('applicant.relationship')).toBe('applicant');
    expect(stepOfField('business.businessEmail')).toBe('applicant');
    expect(stepOfField('registrationNumber')).toBe('business');
    expect(stepOfField('identifiers.IN_GSTIN')).toBe('identifiers');
    expect(stepOfField('addresses.BILLING')).toBe('addresses');
    expect(stepOfField('documents.AUTHORIZATION_LETTER')).toBe('documents');
    expect(stepOfField('consents.BUSINESS_TERMS')).toBe('review');
  });

  it('offers no seller-only question anywhere', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompanyWizard application={application()} />);

    for (const button of stepButtons()) {
      await user.click(button);
      expect(screen.queryByText(/payout|bank account|commission|warehouse|catalogue/i)).not.toBeInTheDocument();
    }
  });
});

describe('CompanyWizard - the representative', () => {
  it('shows the name and phone from the profile, and asks the relationship from a fixed list', () => {
    renderWithProviders(<CompanyWizard application={application()} />);

    expect(screen.getByText('Asha Menon')).toBeInTheDocument();
    expect(screen.getByText('+919876543210')).toBeInTheDocument();
    const relationship = screen.getByLabelText(/relationship to the business/i);
    const options = within(relationship).getAllByRole('option').map((option) => option.getAttribute('value'));
    expect(options).toEqual(['', 'DIRECTOR_OR_OFFICER', 'OWNER_OR_PARTNER', 'EMPLOYEE', 'AUTHORISED_AGENT', 'OTHER']);
  });

  it('says an outside agent will need a letter of authorisation, before they save', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompanyWizard application={application()} />);

    await user.selectOptions(screen.getByLabelText(/relationship to the business/i), 'AUTHORISED_AGENT');
    expect(screen.getByText(/letter of authorisation in the documents step/i)).toBeInTheDocument();
  });

  it('saves the relationship with the step and moves on', async () => {
    const user = userEvent.setup();
    const saved = application({
      applicant: { fullName: 'Asha Menon', phone: '+919876543210', jobTitle: 'Buyer', relationship: 'EMPLOYEE', authorityConfirmed: true },
      problems: [{ field: 'legalName', code: 'REQUIRED' }],
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(saved));
    renderWithProviders(<CompanyWizard application={application()} />);

    await user.type(screen.getByLabelText(/job title/i), 'Buyer');
    await user.selectOptions(screen.getByLabelText(/relationship to the business/i), 'EMPLOYEE');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /save and continue/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toMatchObject({
      applicant: { jobTitle: 'Buyer', relationship: 'EMPLOYEE', authorityConfirmed: true },
    });
    expect(await screen.findByRole('heading', { level: 2, name: /business details/i })).toBeInTheDocument();
  });

  it('stays on the step with everything typed when the server refuses a field', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      errorResponse(422, 'VALIDATION_FAILED', 'Refused.', [{ field: 'applicant.jobTitle', code: 'REQUIRED' }]),
    );
    renderWithProviders(<CompanyWizard application={application()} />);

    await user.type(screen.getByLabelText(/job title/i), 'Buyer');
    await user.selectOptions(screen.getByLabelText(/relationship to the business/i), 'OTHER');
    await user.click(screen.getByRole('button', { name: /save and continue/i }));

    expect(await screen.findByText(/some fields need attention/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /account and representative/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/job title/i)).toHaveValue('Buyer');
    expect(screen.getByLabelText(/relationship to the business/i)).toHaveValue('OTHER');
  });
});

describe('CompanyWizard - identifiers follow the country', () => {
  const india = application({
    business: { ...application().business, registrationCountry: 'IN', entityType: 'PRIVATE_LIMITED_COMPANY' },
    requirements: {
      ...application().requirements,
      register: 'IN_CIN',
      identifiers: [
        { scheme: 'IN_PAN', required: true, allowNotApplicable: false },
        { scheme: 'IN_GSTIN', required: false, allowNotApplicable: true },
        { scheme: 'IN_IEC', required: false, allowNotApplicable: true },
      ],
    },
  });
  const poland = application({
    business: { ...application().business, registrationCountry: 'PL', entityType: 'PRIVATE_LIMITED_COMPANY' },
    requirements: {
      ...application().requirements,
      register: 'PL_KRS',
      identifiers: [
        { scheme: 'PL_NIP', required: true, allowNotApplicable: false },
        { scheme: 'PL_REGON', required: true, allowNotApplicable: false },
        { scheme: 'EU_VAT', required: false, allowNotApplicable: true },
      ],
    },
  });

  async function openIdentifiers(app: CompanyApplication): Promise<void> {
    const user = userEvent.setup();
    renderWithProviders(<CompanyWizard application={app} />);
    await user.click(stepButtons()[2] as HTMLElement);
  }

  it('shows the Indian numbers for an Indian company and no Polish or EU ones', async () => {
    await openIdentifiers(india);
    expect(screen.getByText(/\bPAN\b/)).toBeInTheDocument();
    expect(screen.getByText(/GSTIN/)).toBeInTheDocument();
    expect(screen.queryByText(/\bNIP\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/REGON/)).not.toBeInTheDocument();
  });

  it('shows the Polish numbers for a Polish company and no Indian ones', async () => {
    await openIdentifiers(poland);
    expect(screen.getAllByText(/\bNIP\b/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/REGON/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/GSTIN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bPAN\b/)).not.toBeInTheDocument();
  });

  it('asks for the country first when none has been chosen', async () => {
    await openIdentifiers(application());
    expect(screen.getByText(/choose the country/i)).toBeInTheDocument();
  });
});

describe('CompanyWizard - documents', () => {
  it('refuses an empty file and a file that is not a document before sending anything', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderWithProviders(<CompanyWizard application={application()} />);
    await user.click(stepButtons()[4] as HTMLElement);

    const [input] = screen.getAllByLabelText(/^file/i);
    await user.upload(input as HTMLInputElement, new File(['MZ\u0090'], 'setup.exe', { type: 'application/octet-stream' }));
    expect(await screen.findByText(/upload a pdf, jpeg, png or webp/i)).toBeInTheDocument();

    await user.upload(input as HTMLInputElement, new File([], 'empty.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText(/that file is empty/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the upload\'s progress, then the server\'s refusal of a file that only pretends to be a PDF', async () => {
    const user = userEvent.setup();
    const xhr = installFakeXhr({
      status: 422,
      body: { error: { code: 'VALIDATION_FAILED', message: 'That file is not a PDF, JPEG, PNG or WebP document.', details: [] } },
    });
    renderWithProviders(<CompanyWizard application={application()} />);
    await user.click(stepButtons()[4] as HTMLElement);

    const [input] = screen.getAllByLabelText(/^file/i);
    await user.upload(input as HTMLInputElement, new File(['<html>'], 'invoice.pdf', { type: 'application/pdf' }));

    // Half the body is out: the bar and the words both say so.
    act(() => {
      xhr.progress(0.5);
    });
    expect(await screen.findByText(/uploading… 50%/i)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');

    act(() => {
      xhr.finish();
    });
    expect(await screen.findByText(/not a pdf, jpeg, png or webp document/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    // Sent with the session cookie, like every other write.
    expect(xhr.instance?.withCredentials).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers proof of address and a business licence, marked optional', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompanyWizard application={application()} />);
    await user.click(stepButtons()[4] as HTMLElement);

    expect(screen.getByText('Proof of registered address')).toBeInTheDocument();
    expect(screen.getByText('Business licence')).toBeInTheDocument();
  });
});

describe('localFileProblem', () => {
  it('passes the four document types and refuses the rest by name', () => {
    for (const name of ['a.pdf', 'b.JPG', 'c.jpeg', 'd.png', 'e.webp']) {
      expect(localFileProblem(new File(['x'], name))).toBeNull();
    }
    for (const name of ['a.exe', 'b.html', 'c.svg', 'd.pdf.exe', 'noextension']) {
      expect(localFileProblem(new File(['x'], name))).toBe('companyWizard.documents.wrongType');
    }
  });
});
