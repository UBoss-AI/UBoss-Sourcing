/**
 * The rules behind the agreement screen, and the policy drafts in `legal/`.
 *
 * The drafts are checked here because they are text a person will one day
 * publish: they must parse, must still be visibly drafts, and must not carry
 * the name, contacts or programmes of the company whose documents they were
 * adapted from.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptableVersions,
  consentPurposeFor,
  findLegalPlaceholders,
  termsKindsForScope,
} from '../../src/domain/legal-document.js';
import { parseDraftFile } from '../../src/modules/legal/draft-file.js';

describe('acceptableVersions', () => {
  it('counts only the newest version when it asks for re-acceptance', () => {
    expect(acceptableVersions([
      { version: 'v3', requiresReacceptance: true },
      { version: 'v2', requiresReacceptance: false },
      { version: 'v1', requiresReacceptance: true },
    ])).toEqual(['v3']);
  });

  it('keeps counting older versions across corrections, up to the last real change', () => {
    expect(acceptableVersions([
      { version: 'v3', requiresReacceptance: false },
      { version: 'v2', requiresReacceptance: false },
      { version: 'v1', requiresReacceptance: true },
      { version: 'v0', requiresReacceptance: true },
    ])).toEqual(['v3', 'v2', 'v1']);
  });

  it('counts every version when none asked again, and nothing when nothing is in force', () => {
    expect(acceptableVersions([{ version: 'only', requiresReacceptance: false }])).toEqual(['only']);
    expect(acceptableVersions([])).toEqual([]);
  });
});

describe('termsKindsForScope', () => {
  it('never asks a buyer, carrier, member of staff or auditor for the Seller Addendum', () => {
    for (const scope of ['BUYER', 'LOGISTICS', 'STAFF', 'AUDIT'] as const) {
      expect(termsKindsForScope(scope)).not.toContain('SELLER_TERMS');
    }
    expect(termsKindsForScope('SELLER')).toEqual(['PLATFORM_TERMS', 'SELLER_TERMS']);
  });

  it('gives each kind of account its own Terms', () => {
    expect(termsKindsForScope('BUYER')).toEqual(['PLATFORM_TERMS']);
    expect(termsKindsForScope('LOGISTICS')).toEqual(['LOGISTICS_PARTNER_TERMS']);
    expect(termsKindsForScope('STAFF')).toEqual(['STAFF_TERMS']);
    expect(termsKindsForScope('AUDIT')).toEqual(['AUDIT_CONSOLE_TERMS']);
  });

  it('records the privacy notice as a notice, never as terms', () => {
    expect(consentPurposeFor('PRIVACY_POLICY')).toBe('PRIVACY_NOTICE');
    expect(consentPurposeFor('STAFF_TERMS')).toBe('STAFF_TERMS');
  });
});

describe('findLegalPlaceholders', () => {
  it('finds every blank left for a decision, once each', () => {
    expect(findLegalPlaceholders('Run by [[DECISION: legal name]], at [[DECISION: address]]. [[DECISION: legal name]]')).toEqual([
      '[[DECISION: legal name]]',
      '[[DECISION: address]]',
    ]);
  });

  it('treats an unclosed blank as a blank, and plain brackets as text', () => {
    expect(findLegalPlaceholders('See [[DECISION: unfinished')).toEqual(['[[']);
    expect(findLegalPlaceholders('Clause [1] and [a]')).toEqual([]);
  });
});

describe('parseDraftFile', () => {
  it('reads the header and normalises the body', () => {
    const draft = parseDraftFile('x.txt', 'kind: PRIVACY_POLICY\r\nversion: 2026-10-draft-1\r\nlocale: en\r\ntitle: A notice\r\n---\r\n## One\r\nText.  \r\n\r\n\r\n\r\nMore.');
    expect(draft).toEqual({ kind: 'PRIVACY_POLICY', version: '2026-10-draft-1', locale: 'en', title: 'A notice', body: '## One\nText.\n\nMore.' });
  });

  it('refuses a file with no separator, an unknown kind or an unsupported language', () => {
    expect(() => parseDraftFile('a.txt', 'kind: PRIVACY_POLICY\nbody')).toThrow(/---/);
    expect(() => parseDraftFile('b.txt', 'kind: NOT_A_KIND\nversion: v1\nlocale: en\ntitle: T\n---\nx')).toThrow(/unknown kind/);
    expect(() => parseDraftFile('c.txt', 'kind: STAFF_TERMS\nversion: v1\nlocale: xx\ntitle: T\n---\nx')).toThrow(/language/);
  });
});

describe('the Gloviaa Mart policy drafts', () => {
  const folder = fileURLToPath(new URL('../../../legal/drafts/gloviaa-mart/', import.meta.url));
  const files = readdirSync(folder).filter((file) => file.endsWith('.txt'));
  const drafts = files.map((file) => ({ file, draft: parseDraftFile(file, readFileSync(join(folder, file), 'utf8')) }));

  it('cover every document the agreement screen asks for', () => {
    expect(drafts.map(({ draft }) => draft.kind).sort()).toEqual([
      'AUDIT_CONSOLE_TERMS',
      'LOGISTICS_PARTNER_TERMS',
      'PLATFORM_TERMS',
      'PRIVACY_POLICY',
      'SELLER_TERMS',
      'STAFF_TERMS',
    ]);
  });

  it.each(files)('%s says it is a draft and still has decisions to make, so it cannot be published', (file) => {
    const text = readFileSync(join(folder, file), 'utf8');
    expect(text).toContain('DRAFT - not legal advice and not approved for publication.');
    expect(findLegalPlaceholders(text).length).toBeGreaterThan(0);
  });

  it.each(files)('%s carries no name, address, contact or programme of the source company', (file) => {
    const text = readFileSync(join(folder, file), 'utf8');
    const forbidden = [
      /flipkart/i, /walmart/i, /instakart/i, /samarth/i, /scapic/i, /advanz/i, /bengaluru/i, /bangalore/i,
      /shremanth/i, /\bRBI\b/, /seller\.flipkart/i, /@flipkart\.com/i, /Devarabeesanahalli/i, /Embassy Tech Village/i,
    ];
    for (const pattern of forbidden) expect(text, String(pattern)).not.toMatch(pattern);
  });

  const bodyOf = (kind: string): string => drafts.find(({ draft }) => draft.kind === kind)?.draft.body ?? '';
  const partA = (body: string): string => {
    const start = body.indexOf('## Part A');
    const end = body.indexOf('\n## Part ', start + 1);
    return start < 0 || end < 0 ? '' : body.slice(start, end);
  };

  it('keeps every seller obligation out of the buyer Terms, and in the Seller Addendum', () => {
    const buyer = bodyOf('PLATFORM_TERMS');
    expect(buyer).toContain('## Part B - Terms for buyers');
    expect(buyer).not.toMatch(/^## S\d+\./m);
    expect(buyer).not.toContain('Regulated product declarations');
    expect(bodyOf('SELLER_TERMS')).toMatch(/^## S1\./m);
  });

  it('gives every kind of account the same common terms (Part A), word for word', () => {
    const common = partA(bodyOf('PLATFORM_TERMS'));
    expect(common.length).toBeGreaterThan(1000);
    for (const kind of ['LOGISTICS_PARTNER_TERMS', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS']) {
      expect(partA(bodyOf(kind)), kind).toBe(common);
    }
  });
});
