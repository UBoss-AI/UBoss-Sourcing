/**
 * The agreements the operator supplied as Word documents - the Seller Terms
 * and Conditions, the Seller Platform Services Agreement, the B2B Buyer Terms
 * and Conditions, the B2B Buyer Platform Services Agreement and the B2C
 * Consumer Terms and Conditions - are stored as drafts word for word.
 *
 * Pinned here:
 *
 *   - Every numbered section and every schedule is present, in order.
 *   - The words are the Word document's words. A SHA-256 of the text with
 *     whitespace normalised is pinned, so CI notices a dropped or edited
 *     clause without the .docx (which is not in git: `legal/source/`). Where
 *     the .docx is present the hash is re-derived from it as well.
 *   - Neither can be published as it stands: both still carry the approval
 *     notice and fill-in blanks, and publishing refuses either.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findLegalPlaceholders, LEGAL_APPROVAL_NOTICE, parseLegalBody } from '../../src/domain/legal-document.js';
import { parseDraftFile } from '../../src/modules/legal/draft-file.js';
import { docxParagraphs, normaliseWords } from '../support/docx-text.js';

const drafts = fileURLToPath(new URL('../../../legal/drafts/gloviaa-mart/', import.meta.url));
const sources = fileURLToPath(new URL('../../../legal/source/', import.meta.url));

interface Supplied {
  file: string;
  source: string;
  kind: string;
  title: string;
  headings: string[];
  /** SHA-256 of the title and text, whitespace normalised. */
  wordsSha256: string;
}

const SUPPLIED: Supplied[] = [
  {
    file: 'seller-terms.en.txt',
    source: '02_Seller_Terms_and_Conditions.docx',
    kind: 'SELLER_TERMS',
    title: 'Seller Terms and Conditions',
    headings: [
      '1 Definitions and contractual structure',
      '2 Eligibility and verification',
      '3 Certification audits and ongoing obligations',
      '4 Listings prices and product claims',
      '5 Orders and performance',
      '6 Managed services and delivery',
      '7 Fees and certification recovery',
      '8 Payments reserves and settlement',
      '9 Returns warranties and recalls',
      '10 Insurance and risk support',
      '11 Indemnity and liability',
      '12 Account security confidentiality and privacy',
      '13 Suspension termination and change',
      '14 Governing law and disputes',
      '15 Acceptance and precedence',
    ],
    wordsSha256: '1e56795f6763e57fc0f2cf7f6a5a274757733be3b8aa13d092cdbc2eb5981017',
  },
  {
    file: 'seller-services-agreement.en.txt',
    source: '04_Seller_Platform_Services_Agreement.docx',
    kind: 'SELLER_SERVICES_AGREEMENT',
    title: 'Seller Platform Services Agreement',
    headings: [
      '1 Appointment and purpose',
      '2 Conditions precedent',
      '3 Services and standards',
      '4 Fees invoices and certification funding',
      '5 Escrow settlement and security',
      '6 Product compliance warranties and territory',
      '7 Transport custody title and import responsibilities',
      '8 Complaints recalls and insurance',
      '9 Confidentiality data and intellectual property',
      '10 Indemnity and limitations',
      '11 Term termination and unresolved orders',
      '12 Disputes notices and precedence',
      'Schedule A Approved scope',
      'Schedule B Service mandate',
      'Schedule C Binding fees',
      'Schedule D Settlement and risk security',
      'Schedule E OEM and technical acceptance',
      'Schedule F Insurance and execution',
    ],
    wordsSha256: 'c068052fcab8d0ec74110129415472e623b22b0d264f51d1997976e550de49a0',
  },
  // The company buyer's two agreements, on the storefront's company screen.
  {
    file: 'b2b-buyer-terms.en.txt',
    source: '03_B2B_Buyer_Terms_and_Conditions.docx',
    kind: 'B2B_BUYER_TERMS',
    title: 'B2B Buyer Terms and Conditions',
    headings: [
      '1 Account eligibility and authority',
      '2 Seller disclosure and platform role',
      '3 Quotes RFQs and contract formation',
      '4 Prices charges and payment',
      '5 Importer responsibilities and logistics',
      '6 Delivery receipt and inspection',
      '7 Cancellation returns and remedies',
      '8 Installation and after-sales services',
      '9 Restricted uses and intellectual property',
      '10 Claims payment holds and appeals',
      '11 Buyer indemnity and liability allocation',
      '12 Data recurring purchases and integrations',
      '13 Suspension termination and general provisions',
      '14 Commercial dispute framework and acceptance',
    ],
    wordsSha256: '089c6087eec06b2bb6b1e18d7cb9c446f757179dabae67b090a60c60e96a4039',
  },
  {
    file: 'b2b-buyer-services-agreement.en.txt',
    source: '05_B2B_Buyer_Platform_Services_Agreement.docx',
    kind: 'B2B_BUYER_SERVICES_AGREEMENT',
    title: 'B2B Buyer Platform Services Agreement',
    headings: [
      '1 Purpose and transaction structure',
      '2 Verification and purchasing authority',
      '3 Services mandate and acceptance',
      '4 Orders RFQs and repeat purchasing',
      '5 Fees and buyer-funded certification',
      '6 Payment and escrow administration',
      '7 Export import transport and ownership',
      '8 Receipt inspection installation and claims',
      '9 Buyer duties and indemnity',
      '10 Confidentiality privacy and liability',
      '11 Term suspension and termination',
      '12 Disputes and general terms',
      'Schedule A Service and authority record',
      'Schedule B Commercial and order controls',
      'Schedule C Signatures',
    ],
    wordsSha256: '35bce7beecbbfdaffc7682d4a8b82a80fac5052eb1d250c2699dc39cedaec0c9',
  },
  // The individual buyer's Terms, on the storefront's consumer screen.
  {
    file: 'b2c-consumer-terms.en.txt',
    source: '06_B2C_Consumer_Terms.docx',
    kind: 'B2C_CONSUMER_TERMS',
    title: 'B2C Consumer Terms and Conditions',
    headings: [
      '1 Who supplies your goods and services',
      '2 Accounts and ordering',
      '3 Price payment and certification charge',
      '4 Delivery imports and risk',
      '5 Cancellation before and after dispatch',
      '6 Voluntary returns and defective goods',
      '7 Claims refunds and complaints',
      '8 AI tools repeat orders and privacy',
      '9 Responsibility and fair contract terms',
      '10 Applicable law and dispute routes',
      '11 Model withdrawal notice',
    ],
    wordsSha256: 'fd13f34a88a72063a48ccabf8542bf9c20ab5799a23288e658f0eedea6fdbf5e',
  },
];

describe('B2B Buyer Platform Services Agreement', () => {
  it('ends with the requirement that every incomplete field is completed or marked not applicable', () => {
    const body = draftOf(SUPPLIED[3] as Supplied).body;
    expect(body.trimEnd().endsWith(
      'All incomplete commercial and mandate fields must be completed or expressly marked not applicable before execution or trading.',
    )).toBe(true);
  });
});

describe('B2C Consumer Terms and Conditions', () => {
  const body = (): string => draftOf(SUPPLIED[4] as Supplied).body;
  const section = (heading: string): string => {
    const text = body();
    const start = text.indexOf(`## ${heading}`);
    const next = text.indexOf('\n## ', start + 3);
    return text.slice(start, next === -1 ? undefined : next);
  };

  it('keeps the whole model withdrawal notice, each line its own paragraph, ending the document', () => {
    const lines = parseLegalBody(section('11 Model withdrawal notice'))
      .filter((block) => block.type === 'paragraph')
      .map((block) => (block.type === 'paragraph' ? block.text : ''));
    expect(lines).toEqual([
      'To seller name and address __________________ or Gloviaa cancellation contact __________________.',
      'I hereby give notice that I withdraw from my contract for the following goods or services __________________.',
      'Order number __________________.',
      'Ordered on __________________.',
      'Received on __________________.',
      'Consumer name __________________.',
      'Consumer address __________________.',
      'Signature if on paper __________________.',
      'Date __________________.',
      'You may use another clear statement instead. Consumer purchase terms and country disclosures must be accessible in the applicable language and supplied on a durable medium as required. Complete support privacy grievance and return contacts before publication.',
    ]);
  });

  it('keeps the consumer safeguards the screen relies on, word for word', () => {
    const text = body();
    for (const clause of [
      'Mandatory consumer rights apply regardless of the account label or a term in this document.',
      'The commercial B2B fee cap indemnities arbitration and short acceptance deadlines do not apply to consumers automatically.',
      'Recurring purchases and autopay require your specific consent to frequency limits price handling and cancellation.',
      'Marketing consent is separate where required.',
      'No clause authorises unrestricted international data transfers or use of personal data in public AI services.',
      'a sample form is supplied below but is not compulsory.',
      'You retain applicable payment dispute and chargeback rights.',
    ]) {
      expect(text).toContain(clause);
    }
  });

  it('names every contact still to be supplied, so publishing refuses it until they are', () => {
    const blanks = findLegalPlaceholders(body());
    for (const field of ['registered address', 'corporate registration', 'support contact', 'complaints contact', 'Effective date', 'grievance officer', 'Privacy contact', 'Gloviaa cancellation contact']) {
      expect(blanks.some((blank) => blank.includes(field.slice(-12))), field).toBe(true);
    }
  });
});

function draftOf(supplied: Supplied) {
  return parseDraftFile(supplied.file, readFileSync(`${drafts}${supplied.file}`, 'utf8'));
}

/** The draft's words: title, then the body with the heading markers taken off. */
function draftWords(supplied: Supplied): string {
  const draft = draftOf(supplied);
  return normaliseWords(`${draft.title}\n${draft.body.replace(/^## /gm, '')}`);
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe.each(SUPPLIED)('$file', (supplied) => {
  it('is the supplied document, kind and title', () => {
    const draft = draftOf(supplied);
    expect(draft.kind).toBe(supplied.kind);
    expect(draft.title).toBe(supplied.title);
    expect(draft.version).toBe('1.0');
    expect(draft.body).toContain('Gloviaa Mart | Uboss AI Private Limited');
    expect(draft.body).toContain('Version 1.0 | Prepared 9 October 2026 | Effective date');
  });

  it('has every numbered section and schedule, in order, as headings', () => {
    const headings = parseLegalBody(draftOf(supplied).body)
      .filter((block) => block.type === 'heading')
      .map((block) => (block.type === 'heading' ? block.text : ''));
    expect(headings).toEqual(supplied.headings);
  });

  it('has not lost or changed a word since it was taken from Word', () => {
    expect(sha256(draftWords(supplied))).toBe(supplied.wordsSha256);
  });

  it.skipIf(!existsSync(`${sources}${supplied.source}`))('matches the Word document itself, whitespace aside', () => {
    const words = normaliseWords(docxParagraphs(`${sources}${supplied.source}`).map((p) => p.text).join('\n'));
    expect(draftWords(supplied)).toBe(words);
  });

  it('cannot be published yet: the approval notice and the blanks are still in it', () => {
    const blanks = findLegalPlaceholders(draftOf(supplied).body);
    expect(blanks).toContain(LEGAL_APPROVAL_NOTICE);
    expect(blanks.some((blank) => blank.endsWith('_____'))).toBe(true);
  });
});
