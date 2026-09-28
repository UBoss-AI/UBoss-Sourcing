/**
 * The rules a legal document follows: one hash, one "which version is in
 * force", one reading of the text - and no code that could change a published
 * document behind the service's back.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  legalContentHash,
  normaliseLegalText,
  parseLegalBody,
  pickCurrent,
  termsKindForUserType,
} from '../../src/domain/legal-document.js';

const content = {
  kind: 'PLATFORM_TERMS',
  version: '2026-10-01',
  locale: 'en',
  title: 'Terms and Conditions',
  body: '## One\nFirst paragraph.\n\n- a\n- b',
};

describe('legalContentHash', () => {
  it('is the same for text that differs only in line endings and trailing spaces', () => {
    const windows = { ...content, body: '## One  \r\nFirst paragraph.\r\n\r\n\r\n- a\r\n- b\r\n' };
    expect(legalContentHash(windows)).toBe(legalContentHash(content));
  });

  it('changes when a word changes', () => {
    expect(legalContentHash({ ...content, body: content.body.replace('First', 'Second') })).not.toBe(
      legalContentHash(content),
    );
  });

  it('changes with the version and the language, so a translation is its own document', () => {
    expect(legalContentHash({ ...content, version: '2026-10-02' })).not.toBe(legalContentHash(content));
    expect(legalContentHash({ ...content, locale: 'pl' })).not.toBe(legalContentHash(content));
  });

  it('is a SHA-256 in hex', () => {
    expect(legalContentHash(content)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseLegalBody', () => {
  it('reads headings, paragraphs and bullets, and nothing else', () => {
    expect(
      parseLegalBody('## Heading\nline one\nline two\n\n- first\n  continued\n* second\n\nAfter <b>x</b>'),
    ).toEqual([
      { type: 'heading', text: 'Heading' },
      { type: 'paragraph', text: 'line one line two' },
      { type: 'list', items: ['first continued', 'second'] },
      // Markup is text. It is never interpreted by any surface.
      { type: 'paragraph', text: 'After <b>x</b>' },
    ]);
  });

  it('gives nothing for empty text', () => {
    expect(parseLegalBody('  \n\n ')).toEqual([]);
  });
});

describe('normaliseLegalText', () => {
  it('collapses runs of blank lines and trims', () => {
    expect(normaliseLegalText('\n\na\n\n\n\nb  \n')).toBe('a\n\nb');
  });
});

describe('pickCurrent', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const row = (version: string, effective: string, published = effective) => ({
    version,
    effectiveAt: new Date(effective),
    publishedAt: new Date(published),
  });

  it('is the newest version whose effective date has passed', () => {
    const rows = [row('v1', '2026-01-01T00:00:00Z'), row('v2', '2026-10-01T00:00:00Z'), row('v3', '2026-11-01T00:00:00Z')];
    expect(pickCurrent(rows, now)?.version).toBe('v2');
  });

  it('breaks a same-moment tie by the later publication', () => {
    const rows = [
      row('v2', '2026-10-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      row('v2a', '2026-10-01T00:00:00Z', '2026-09-02T00:00:00Z'),
    ];
    expect(pickCurrent(rows, now)?.version).toBe('v2a');
  });

  it('is null when nothing has taken effect', () => {
    expect(pickCurrent([row('v3', '2026-11-01T00:00:00Z')], now)).toBeNull();
    expect(pickCurrent([], now)).toBeNull();
  });
});

describe('termsKindForUserType', () => {
  it('asks carrier staff for the carrier terms and everybody else for the buyer terms', () => {
    expect(termsKindForUserType('LOGISTICS')).toBe('LOGISTICS_PARTNER_TERMS');
    expect(termsKindForUserType('CUSTOMER')).toBe('PLATFORM_TERMS');
    // Unknown falls to asking for terms, never to asking for none.
    expect(termsKindForUserType('SOMETHING_NEW')).toBe('PLATFORM_TERMS');
  });
});

describe('published documents are only ever changed through the service', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (entry === 'generated') return [];
      return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
    });
  }

  it('has no unconditional update, delete or upsert of a legal document', () => {
    // The service changes and deletes rows only with `updateMany`/`deleteMany`
    // conditioned on status DRAFT, so a published row can never match.
    const pattern = /\.legalDocument\.(update|delete|upsert)\(/;
    const offenders = sources(join(here, '../../src')).filter((file) => pattern.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('conditions every legal-document updateMany and deleteMany on DRAFT', () => {
    const file = readFileSync(join(here, '../../src/modules/legal/legal-document.service.ts'), 'utf8');
    const calls = [...file.matchAll(/\.legalDocument\.(updateMany|deleteMany)\(\{\s*where: \{([^}]*)\}/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call[2]).toContain("status: 'DRAFT'");
  });

  it('no source outside the legal module writes a legal document', () => {
    const writer = /\.legalDocument\.(create|createMany|updateMany|deleteMany)\(/;
    const offenders = sources(join(here, '../../src'))
      .filter((file) => !file.replace(/\\/g, '/').includes('/modules/legal/'))
      .filter((file) => writer.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
