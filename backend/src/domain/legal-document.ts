/**
 * The rules a legal document follows, with no database in sight.
 *
 * Three questions are answered here and nowhere else, because a second answer
 * to any of them is how a customer ends up bound by words nobody can produce:
 *
 *   1. **What exactly was published?** `legalContentHash` over one canonical
 *      form of the text. The same hash is stored on the document when it is
 *      published and copied onto every acceptance, so a later dispute can
 *      re-derive it from the archived row and show the words are unchanged.
 *   2. **Which version is in force?** `pickCurrent`: the newest published
 *      version whose effective date has passed.
 *   3. **What does the text look like?** `parseLegalBody`: plain text with two
 *      markers, never HTML. The storefront, the carrier portal, the console
 *      and the PDF all render from these blocks, so none of them can show a
 *      different document from the one that was hashed.
 */
import { createHash } from 'node:crypto';

/**
 * The agreements an account accepts at sign-up. Only these can be accepted:
 * the kind is always chosen by the server from the account type
 * (`termsKindForUserType`), never by the browser.
 */
export const TERMS_KINDS = ['PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS'] as const;
export type TermsKindName = (typeof TERMS_KINDS)[number];

/**
 * The published policies (checklist Master row 9): informational, versioned and
 * hashed exactly like the terms, listed in the storefront's help and policies
 * hub - and never accepted at sign-up.
 */
export const POLICY_KINDS = [
  'SELLER_TERMS',
  'PRIVACY_POLICY',
  'RETURNS_POLICY',
  'BUYER_PROTECTION_POLICY',
  'INSPECTION_POLICY',
  'PROHIBITED_PRODUCTS',
] as const;
export type PolicyKindName = (typeof POLICY_KINDS)[number];

/**
 * The terms the operator's own staff accept on the admin console's agreement
 * screen. Not a sign-up agreement and not a policy: it is for staff, so the
 * storefront's help hub (`listDocumentsInForce`) never lists it.
 */
export const STAFF_TERMS_KIND = 'STAFF_TERMS' as const;

/** The terms Audit Console users - inspection agencies, auditors - accept. */
export const AUDIT_CONSOLE_TERMS_KIND = 'AUDIT_CONSOLE_TERMS' as const;

/** Every kind the legal-document service manages. */
export const LEGAL_DOCUMENT_KINDS = [
  ...TERMS_KINDS,
  ...POLICY_KINDS,
  STAFF_TERMS_KIND,
  AUDIT_CONSOLE_TERMS_KIND,
] as const;
export type LegalDocumentKindName = (typeof LEGAL_DOCUMENT_KINDS)[number];

export function isTermsKind(kind: string): kind is TermsKindName {
  return (TERMS_KINDS as readonly string[]).includes(kind);
}

/** Where an acceptance was given. Stored on the consent record. */
export const TERMS_ACCEPTANCE_SOURCES = [
  'STOREFRONT_SIGN_UP',
  'CUSTOMER_INVITATION',
  'LOGISTICS_INVITATION',
  'AGREEMENT_SCREEN',
] as const;

// ---------------------------------------------------------------------------
// The agreement screen after sign-in
// ---------------------------------------------------------------------------

/**
 * Which kind of account the agreement screen is asking for.
 *
 * One person can be several: a buyer who also sells is BUYER on the storefront
 * and SELLER in the Seller Hub. The scope decides which Terms apply, never
 * whether the Privacy Policy does - it always does.
 */
export const AGREEMENT_SCOPES = ['BUYER', 'SELLER', 'LOGISTICS', 'STAFF', 'AUDIT'] as const;
export type AgreementScopeName = (typeof AGREEMENT_SCOPES)[number];

/** The Terms kinds an agreement screen can ask for. */
export const AGREEMENT_TERMS_KINDS = [
  'PLATFORM_TERMS',
  'SELLER_TERMS',
  'LOGISTICS_PARTNER_TERMS',
  STAFF_TERMS_KIND,
  AUDIT_CONSOLE_TERMS_KIND,
] as const;
export type AgreementTermsKind = (typeof AGREEMENT_TERMS_KINDS)[number];

/** The one notice everybody acknowledges, whatever their scope. */
export const PRIVACY_NOTICE_KIND = 'PRIVACY_POLICY' as const;

export type AgreementDocumentKind = AgreementTermsKind | typeof PRIVACY_NOTICE_KIND;

/**
 * The Terms a scope must have accepted, in the order they are read.
 *
 * A seller accepts the buyer-facing Terms of Use AND the Seller Addendum: the
 * addendum supplements the Terms of Use and makes no sense alone. A buyer
 * never sees the addendum - nobody accepts obligations of a role they do not
 * hold. Carrier staff, operator staff and Audit Console users each have one
 * document that carries the common terms and their own part.
 */
export function termsKindsForScope(scope: AgreementScopeName): readonly AgreementTermsKind[] {
  switch (scope) {
    case 'BUYER':
      return ['PLATFORM_TERMS'];
    case 'SELLER':
      return ['PLATFORM_TERMS', 'SELLER_TERMS'];
    case 'LOGISTICS':
      return ['LOGISTICS_PARTNER_TERMS'];
    case 'STAFF':
      return [STAFF_TERMS_KIND];
    case 'AUDIT':
      return [AUDIT_CONSOLE_TERMS_KIND];
  }
}

export function isAgreementTermsKind(kind: string): kind is AgreementTermsKind {
  return (AGREEMENT_TERMS_KINDS as readonly string[]).includes(kind);
}

/**
 * The consent purpose a record of this kind is stored under. The privacy
 * notice keeps its long-standing purpose, PRIVACY_NOTICE: an acknowledgement,
 * not a consent in the GDPR Art. 6(1)(a) sense.
 */
export function consentPurposeFor(kind: AgreementDocumentKind): AgreementTermsKind | 'PRIVACY_NOTICE' {
  return kind === PRIVACY_NOTICE_KIND ? 'PRIVACY_NOTICE' : kind;
}

export interface VersionRequirementRow {
  version: string;
  requiresReacceptance: boolean;
}

/**
 * The versions of one kind whose acceptance still counts, given every version
 * in force NEWEST FIRST (one entry per version).
 *
 * The newest always counts. Walking back, each older version counts too until
 * a version that asked for re-acceptance is passed: an acceptance of anything
 * before that one is no longer enough. A version published as a correction
 * (`requiresReacceptance` false) therefore asks nobody again, and the first
 * version of a kind - with nothing older - ends the walk by running out.
 */
export function acceptableVersions(newestFirst: readonly VersionRequirementRow[]): string[] {
  const acceptable: string[] = [];
  for (const row of newestFirst) {
    acceptable.push(row.version);
    if (row.requiresReacceptance) break;
  }
  return acceptable;
}

/**
 * A blank left for a decision, written `[[...]]`. Drafts carry them on
 * purpose - "[[DECISION: registered legal name]]" - and publishing refuses a
 * document that still holds one, so nobody can be bound by a blank.
 */
export const LEGAL_PLACEHOLDER_PATTERN = /\[\[[^\]\n]{0,300}\]\]/g;

export function findLegalPlaceholders(text: string): string[] {
  const found = [...new Set(text.match(LEGAL_PLACEHOLDER_PATTERN) ?? [])];
  // An opening "[[" whose close was lost in editing is still a blank.
  if (found.length === 0 && text.includes('[[')) found.push('[[');
  return found;
}
export type TermsAcceptanceSource = (typeof TERMS_ACCEPTANCE_SOURCES)[number];

/**
 * Which agreement an account of this type is asked for.
 *
 * A carrier's staff are not buyers and are never shown the buyer terms. Every
 * other account that can be activated through a public page is a buyer - and
 * an unexpected type falls to the buyer terms rather than to none, so this
 * can only ever ask for more than it should, never less.
 */
export function termsKindForUserType(userType: string): TermsKindName {
  return userType === 'LOGISTICS' ? 'LOGISTICS_PARTNER_TERMS' : 'PLATFORM_TERMS';
}

/** "2026-10-01", "v3", "2026.2". Letters, digits, dot, dash, underscore. */
export const LEGAL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export const LEGAL_TITLE_MAX = 200;
/** About 150 pages of prose. A body longer than this is a mistake, not a contract. */
export const LEGAL_BODY_MAX = 400_000;
export const LEGAL_CHANGE_SUMMARY_MAX = 2_000;

/**
 * The one form text is stored in.
 *
 * Line endings become `\n`, trailing spaces go, runs of blank lines become one
 * and the ends are trimmed. Applied when a draft is saved, so the text an
 * editor sees back is the text that will be hashed - a hash over a form nobody
 * can see would be impossible to check by hand.
 */
export function normaliseLegalText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface LegalContent {
  kind: string;
  version: string;
  locale: string;
  title: string;
  body: string;
}

/**
 * SHA-256 of a document's words and identity.
 *
 * The prefix names the scheme, so a future change to the canonical form can
 * be told apart from a tampered document. The effective date is deliberately
 * not part of it: the hash answers "which words", and the date is stored
 * beside it on a row that can no longer change.
 */
export function legalContentHash(content: LegalContent): string {
  const canonical = [
    'uboss-legal-document-v1',
    content.kind,
    content.version,
    content.locale,
    normaliseLegalText(content.title),
    '',
    normaliseLegalText(content.body),
  ].join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export type LegalBlock =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] };

/**
 * Plain text into blocks.
 *
 * `## ` starts a heading, `- ` or `* ` a bullet, a blank line ends a
 * paragraph. Lines of one paragraph are joined with a space. Nothing else has
 * a meaning - no links, no emphasis, no HTML - so stored text can never turn
 * into markup on any of the four surfaces that render it.
 */
export function parseLegalBody(body: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  const flushList = (): void => {
    if (list !== null && list.length > 0) blocks.push({ type: 'list', items: list });
    list = null;
  };

  for (const raw of normaliseLegalText(body).split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flushParagraph();
      flushList();
    } else if (line.startsWith('## ')) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', text: line.slice(3).trim() });
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      flushParagraph();
      list ??= [];
      list.push(line.slice(2).trim());
    } else if (list !== null) {
      // A continuation of the last bullet, wrapped by whoever typed it.
      list[list.length - 1] = `${list[list.length - 1] ?? ''} ${line}`;
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

export interface PublishedVersionRow {
  version: string;
  effectiveAt: Date;
  publishedAt: Date | null;
}

/**
 * The version in force at `now`, or null when none is.
 *
 * The newest effective date that has passed wins. Two versions effective at
 * the same moment - a correction published the same day - are decided by
 * which was published last.
 */
export function pickCurrent<T extends PublishedVersionRow>(rows: readonly T[], now: Date): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (row.effectiveAt.getTime() > now.getTime()) continue;
    if (best === null) {
      best = row;
      continue;
    }
    const byEffective = row.effectiveAt.getTime() - best.effectiveAt.getTime();
    const byPublished = (row.publishedAt?.getTime() ?? 0) - (best.publishedAt?.getTime() ?? 0);
    if (byEffective > 0 || (byEffective === 0 && byPublished > 0)) best = row;
  }
  return best;
}
