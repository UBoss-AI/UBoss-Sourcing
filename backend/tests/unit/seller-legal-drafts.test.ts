/**
 * The agreements the operator supplied as Word documents - the Seller Terms
 * and Conditions, the Seller Platform Services Agreement, the B2B Buyer Terms
 * and Conditions, the B2B Buyer Platform Services Agreement and the B2C
 * Consumer Terms and Conditions. They were taken from Word word for word, then
 * finalised on 12 October 2026: every blank filled, the approval notice
 * removed (see `legal/drafts/gloviaa-mart/CHANGE-TABLE.md`).
 *
 * Pinned here:
 *
 *   - Every numbered section and every schedule is present, in order.
 *   - A SHA-256 of the finished text with whitespace normalised, so CI
 *     notices a dropped or edited clause. Change it only with the text.
 *   - Each can be published: no approval notice and no fill-in blank is left.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findLegalPlaceholders, parseLegalBody } from '../../src/domain/legal-document.js';
import { parseDraftFile } from '../../src/modules/legal/draft-file.js';
import { normaliseWords } from '../support/docx-text.js';

const drafts = fileURLToPath(new URL('../../../legal/drafts/gloviaa-mart/', import.meta.url));

interface Supplied {
  file: string;
  kind: string;
  title: string;
  headings: string[];
  /** SHA-256 of the title and text, whitespace normalised. */
  wordsSha256: string;
}

const SUPPLIED: Supplied[] = [
  {
    file: 'seller-terms.en.txt',
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
    wordsSha256: '0a539f994e2ac0bd45f71c31dca4f685fcbfe6e9652d1feb1a555f44c776e3e3',
  },
  {
    file: 'seller-services-agreement.en.txt',
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
    wordsSha256: 'e60d9e01f4bd6044ddd9355a35fb8a3e9d9c8722da67f077e91644f33b091b61',
  },
  // The company buyer's two agreements, on the storefront's company screen.
  {
    file: 'b2b-buyer-terms.en.txt',
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
    wordsSha256: '5c6e26eb8acae76ea658680f10e37b9058bf5bdd66fcea67ce69a2cba6a43f42',
  },
  {
    file: 'b2b-buyer-services-agreement.en.txt',
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
    wordsSha256: 'ddc183d086b9bb78565f3d116bfa5722192925d43b101c6e7bda8b1515b7b443',
  },
  // The individual buyer's Terms, on the storefront's consumer screen.
  {
    file: 'b2c-consumer-terms.en.txt',
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
    wordsSha256: 'a374fc18182fcc62412315da635c7944861e478372146bc0fe863d2323bfed88',
  },
];

describe('B2B Buyer Platform Services Agreement', () => {
  it('ends by taking the buyer particulars from its verified account', () => {
    const body = draftOf(SUPPLIED[3] as Supplied).body;
    expect(body.trimEnd().endsWith(
      "The Buyer's legal particulars, authorised users and spending limits are taken from the Buyer's verified account at the time of acceptance, and the Buyer must keep them accurate and up to date on the Platform.",
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
      'To: the seller named in your order confirmation, or Gloviaa Mart, returns@gloviaamart.com, at our registered office.',
      'I hereby give notice that I withdraw from my contract for the following goods or services: (insert the goods or services).',
      'Order number: (insert order number).',
      'Ordered on: (insert date ordered).',
      'Received on: (insert date received).',
      'Consumer name: (insert your name).',
      'Consumer address: (insert your address).',
      'Signature, if this form is sent on paper: (insert signature).',
      'Date: (insert date).',
      'You may use any other clear statement instead of this form. These terms and the information for your country are available in the applicable language and are supplied to you on a durable medium, such as email or a downloadable document, as the law requires.',
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

  it('names its support, complaints, grievance, privacy and cancellation contacts', () => {
    const text = body();
    for (const contact of ['support@gloviaamart.com', 'grievance@gloviaamart.com', 'privacy@gloviaamart.com', 'returns@gloviaamart.com', 'Effective 12 October 2026']) {
      expect(text, contact).toContain(contact);
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
    expect(draft.body).toContain('Version 1.0 | Effective 12 October 2026');
  });

  it('has every numbered section and schedule, in order, as headings', () => {
    const headings = parseLegalBody(draftOf(supplied).body)
      .filter((block) => block.type === 'heading')
      .map((block) => (block.type === 'heading' ? block.text : ''));
    expect(headings).toEqual(supplied.headings);
  });

  it('has not lost or changed a word since it was finalised', () => {
    expect(sha256(draftWords(supplied))).toBe(supplied.wordsSha256);
  });

  it('can be published: no approval notice and no blank is left in it', () => {
    expect(findLegalPlaceholders(draftOf(supplied).body)).toEqual([]);
  });
});
