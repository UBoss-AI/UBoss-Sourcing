/**
 * The agreement screen's data, as the server sends it, and the one interface
 * each app implements to reach its own surface.
 *
 * `components/agreement-kit/` is one set of files kept in four apps - the
 * storefront (and its Seller Hub), the admin console, the carrier portal and
 * the Audit Console. `agreement-kit-sync.test.ts` fails the moment the copies
 * differ: change one, copy the folder to the other three. Everything that
 * differs between the apps - the URL prefix, the PDF link, the sign-out, the
 * marketplace name - comes in through `AgreementsClient` and the props.
 */

/**
 * CONSUMER is the storefront's screen for somebody shopping for themselves
 * once its documents are published. The app always asks as BUYER; the server
 * answers with the scope that applies.
 */
export type AgreementScope = 'BUYER' | 'SELLER' | 'LOGISTICS' | 'STAFF' | 'AUDIT' | 'COMPANY_BUYER' | 'CONSUMER';

/**
 * The boxes on the screen. SERVICES - a Platform Services Agreement - is a
 * box of its own on the Seller Hub's, the company's and the consumer's screen.
 */
export type AgreementRole = 'TERMS' | 'PRIVACY' | 'SERVICES';

export interface AgreementDocument {
  id: string;
  kind: string;
  version: string;
  locale: string;
  title: string;
  body: string;
  changeSummary: string | null;
  effectiveAt: string;
  publishedAt: string;
  contentSha256: string;
}

export interface CurrentAgreementDocument {
  document: AgreementDocument;
  requestedLocale: string;
  /** The document is not published in the reader's language. */
  isFallback: boolean;
}

export interface AgreementRecord {
  recordId: string;
  documentId: string;
  version: string;
  locale: string;
  action: 'TERMS_ACCEPTED' | 'PRIVACY_NOTICE_ACKNOWLEDGED';
  /** Server time, ISO. */
  recordedAt: string;
  /** A company-level acceptance another member gave: it counts, and it is not this person's to clear. */
  byOtherMember?: boolean;
}

export interface AgreementDocumentStatus {
  kind: string;
  current: CurrentAgreementDocument | null;
  record: AgreementRecord | null;
  unavailable: boolean;
}

export interface AgreementStatus {
  scope: AgreementScope;
  terms: AgreementDocumentStatus[];
  /** The Seller Platform Services Agreement on the SELLER scope; empty (or absent) elsewhere. */
  services?: AgreementDocumentStatus[];
  privacy: AgreementDocumentStatus;
  termsComplete: boolean;
  servicesComplete?: boolean;
  privacyComplete: boolean;
  complete: boolean;
  /** The company a COMPANY_BUYER screen is for; null or absent elsewhere. */
  company?: { companyId: string; companyName: string; canBind: boolean } | null;
  /** COMPANY_BUYER: the services box waits for an owner or company admin. */
  awaitingSignatory?: boolean;
}

export interface AgreementHistoryEntry {
  recordId: string;
  kind: string;
  title: string;
  documentId: string;
  version: string;
  locale: string;
  action: 'TERMS_ACCEPTED' | 'PRIVACY_NOTICE_ACKNOWLEDGED';
  scope: AgreementScope | null;
  recordedAt: string;
  clearedAt: string | null;
  withdrawnAt: string | null;
}

/**
 * How the kit reaches the server and the rest of the app. Each app builds one
 * in `lib/agreements.ts`.
 */
export interface AgreementsClient {
  status: (scope: AgreementScope, locale: string) => Promise<AgreementStatus>;
  record: (scope: AgreementScope, role: AgreementRole, documentIds: string[], locale: string) => Promise<AgreementStatus>;
  clear: (scope: AgreementScope, role: AgreementRole, locale: string) => Promise<AgreementStatus>;
  history: () => Promise<AgreementHistoryEntry[]>;
  /** The published document of a kind in force now - public, for a sign-in form. Rejects when none is. */
  currentDocument: (kind: string, locale: string) => Promise<CurrentAgreementDocument>;
  /** A link to the PDF of one published document. */
  pdfUrl: (documentId: string) => string;
  /** A page where one published document can be read, or null where the app has none. */
  pageUrl: (documentId: string) => string | null;
  /** Subscribe to the API refusing a request with AGREEMENTS_REQUIRED. Returns the unsubscribe. */
  onRequired: (listener: () => void) => () => void;
  /** The error code of a failed call, or null when it was not a server answer. */
  errorCode: (error: unknown) => string | null;
}
