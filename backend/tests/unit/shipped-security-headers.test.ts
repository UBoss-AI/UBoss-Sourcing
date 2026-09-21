/**
 * The security headers this project SHIPS, checked as configuration.
 *
 * Why a test rather than a review note: the audit of September 2026 found the
 * nginx snippet enforcing its Content-Security-Policy and all four Netlify
 * configurations still emitting `Content-Security-Policy-Report-Only`. Nobody
 * had changed anything wrongly - one file was switched to enforcing and the
 * others were simply not noticed, which is what happens to a rule that lives
 * only in somebody's memory. A header that blocks nothing looks exactly like
 * one that blocks everything until you read the name.
 *
 * So the rule is written down here, where a pull request that loosens it turns
 * a build red. It reads the shipped files from disk; it does not describe them.
 *
 * It deliberately does NOT check the API's own helmet policy. That one is
 * assembled at runtime and helmet merges its own defaults into it, so reading
 * the source is exactly the thing that cannot answer what goes out - see
 * `tests/integration/api-security-headers.test.ts`, which makes a request and
 * reads the header off the response.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every file that sets browser security headers for a shipped front end. */
const HEADER_SOURCES = [
  'deploy/nginx/snippets/uboss-security-headers.conf',
  'apps/customer-web/netlify.toml',
  'apps/admin-web/netlify.toml',
  'apps/logistics-web/netlify.toml',
  'deploy/netlify-combined.toml',
] as const;

function read(relativePath: string): string {
  return readFileSync(join(REPO, relativePath), 'utf8');
}

/**
 * Lines that actually SET a header, with comments removed.
 *
 * Both formats put the directive and the value on one line, and both use `#`
 * for comments, so one filter serves both. Without it, a commented-out
 * example of a bad policy would fail these tests.
 */
function settingLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * The line that actually carries the policy.
 *
 * nginx splits it in two - a `set $uboss_csp "..."` holding the directives and
 * an `add_header Content-Security-Policy $uboss_csp` emitting them - while a
 * netlify.toml puts both on one line. Matching on a directive rather than on
 * the header name finds the right line in either shape.
 */
function policyLine(text: string): string | undefined {
  return settingLines(text).find((line) => line.includes('default-src'));
}

describe('the Content-Security-Policy is enforcing everywhere it is set', () => {
  it.each(HEADER_SOURCES)('%s does not ship a report-only policy', (source) => {
    const lines = settingLines(read(source));
    const reportOnly = lines.filter((line) => line.includes('Content-Security-Policy-Report-Only'));

    expect(
      reportOnly,
      `${source} sets Content-Security-Policy-Report-Only, which blocks nothing. ` +
        'Report-only is for deriving a policy, not for shipping one.',
    ).toEqual([]);
  });

  it.each(HEADER_SOURCES)('%s sets an enforcing policy', (source) => {
    const lines = settingLines(read(source));
    expect(lines.some((line) => /Content-Security-Policy\b/.test(line))).toBe(true);
  });
});

describe('the directives that must be present and must not be weakened', () => {
  /**
   * Each of these closes something specific:
   *   default-src 'self'   nothing loads from anywhere by default
   *   object-src 'none'    no Flash/PDF plugin surface
   *   base-uri 'self'      an injected <base> cannot repoint every relative URL
   *   form-action 'self'   a form cannot be made to post somewhere else
   *   frame-ancestors      clickjacking, in the modern spelling
   */
  const REQUIRED = [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  it.each(HEADER_SOURCES)('%s keeps every required directive', (source) => {
    const policy = policyLine(read(source));
    expect(policy).toBeDefined();

    for (const directive of REQUIRED) {
      expect(policy, `${source} is missing ${directive}`).toContain(directive);
    }
  });

  /**
   * The two that turn a CSP back into decoration.
   *
   * `'unsafe-eval'` re-enables string-to-code, and a wildcard in `script-src`
   * means any host may supply the page's JavaScript. `style-src
   * 'unsafe-inline'` is a known, documented exception recorded in
   * SECURITY-AUDIT-REPORT.md and is NOT in this list - which is the point of
   * naming the forbidden things explicitly rather than banning "unsafe".
   */
  it.each(HEADER_SOURCES)('%s never allows eval or a script wildcard', (source) => {
    const policy = policyLine(read(source)) ?? '';

    expect(policy).not.toContain("'unsafe-eval'");

    const scriptSrc = /script-src ([^;"]*)/.exec(policy)?.[1] ?? '';
    expect(scriptSrc, `${source} allows script from anywhere`).not.toMatch(/(^|\s)\*(\s|$)/);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });
});

describe('the headers that are not the CSP', () => {
  const REQUIRED_HEADERS = [
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Referrer-Policy',
    'Permissions-Policy',
  ];

  it.each(HEADER_SOURCES)('%s sets all of them', (source) => {
    const text = settingLines(read(source)).join('\n');
    for (const header of REQUIRED_HEADERS) {
      expect(text, `${source} does not set ${header}`).toContain(header);
    }
  });

  it.each(HEADER_SOURCES)('%s asks for at least a year of HSTS', (source) => {
    const line =
      settingLines(read(source)).find((entry) => entry.includes('Strict-Transport-Security')) ?? '';
    const maxAge = Number(/max-age=(\d+)/.exec(line)?.[1] ?? '0');

    expect(maxAge).toBeGreaterThanOrEqual(31_536_000);
    expect(line).toContain('includeSubDomains');
  });
});

describe('uploaded bytes are served under their own, stricter rules', () => {
  /**
   * The media location carries a second, narrower policy on top of the site's.
   * A browser applies both and takes the intersection, so an uploaded file
   * cannot run under the storefront's much broader policy. Removing the
   * narrow one to "tidy up the duplicate" is the mistake this guards.
   */
  it('keeps the sandboxed policy and the attachment headers on /media/products/', () => {
    const conf = read('deploy/nginx/uboss.conf');
    const block = /location \/media\/products\/ \{[\s\S]*?\n {4}\}/.exec(conf)?.[0] ?? '';

    expect(block, 'the /media/products/ location has moved or changed shape').not.toBe('');
    expect(block).toContain("default-src 'none'; sandbox");
    expect(block).toContain('X-Content-Type-Options "nosniff"');
  });
});

describe('source maps are not served', () => {
  /**
   * Both release paths delete them, and both could be bypassed by a hand-run
   * build on the box. A map is the complete TypeScript source of the admin
   * console, route names and permission keys included.
   */
  it('has a 404 guard in every nginx server block', () => {
    const conf = read('deploy/nginx/uboss.conf');
    const serverBlocks = conf.split(/^server \{/m).length - 1;
    const guards = (conf.match(/location ~\* \\\.map\$/g) ?? []).length;

    // One fewer guard than server blocks: the plain-HTTP block only redirects.
    expect(guards).toBe(serverBlocks - 1);
  });

  it('is still deleted by the release script and the deploy workflow', () => {
    expect(read('deploy/scripts/release.sh')).toContain("find dist -name '*.map' -delete");
    expect(read('.github/workflows/deploy.yml')).toContain("find apps/*/dist -name '*.map' -delete");
  });
});

describe('the sign-in rate limit at the edge covers every surface', () => {
  /**
   * The audit found the tighter `uboss_auth_zone` applied only to
   * `/api/v1/auth/...`, which is the storefront. The admin console signs in at
   * `/api/v1/admin/auth/login` and the carrier portal at
   * `/api/v1/logistics/auth/login`, so the two accounts that can refund an
   * order or move a consignment were held to the general limit instead.
   */
  const SIGN_IN_PATHS = [
    '/api/v1/auth/login',
    '/api/v1/admin/auth/login',
    '/api/v1/logistics/auth/login',
    '/api/v1/auth/password/reset',
    '/api/v1/admin/auth/password/change',
  ];

  const ORDINARY_PATHS = ['/api/v1/orders', '/api/v1/catalog/products', '/api/v1/seller/listings'];

  it('matches every sign-in path and no ordinary one', () => {
    const conf = read('deploy/nginx/uboss.conf');
    const pattern = /location ~ (\^\/api\/v1\/\S+auth\S+) \{/.exec(conf)?.[1];

    expect(pattern, 'the auth rate-limit location has been renamed or removed').toBeDefined();

    const regex = new RegExp(pattern ?? '$^');

    for (const path of SIGN_IN_PATHS) {
      expect(regex.test(path), `${path} is not held to the tighter sign-in limit`).toBe(true);
    }
    for (const path of ORDINARY_PATHS) {
      expect(regex.test(path), `${path} is wrongly held to the sign-in limit`).toBe(false);
    }
  });

  it('applies the auth zone in every server block that proxies the API', () => {
    const conf = read('deploy/nginx/uboss.conf');
    const authLocations = (conf.match(/limit_req zone=uboss_auth_zone/g) ?? []).length;
    const apiLocations = (conf.match(/limit_req zone=uboss_api_zone/g) ?? []).length;

    expect(authLocations).toBe(apiLocations);
  });
});
