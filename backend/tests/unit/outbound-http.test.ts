/**
 * The address guard: what this server will and will not be told to call.
 *
 * `outbound-http.ts` is the only place in the system where a URL a CUSTOMER
 * typed becomes an outbound HTTP request with a credential attached. That makes
 * it the one module where a missing check is not a bug but a server-side
 * request forgery primitive with a form field in front of it, so these tests
 * are written adversarially: each case is a real way people reach the loopback
 * interface or a cloud metadata endpoint, not a spelling of `localhost`.
 *
 * The four families they cover:
 *
 *   1. **Alternative spellings.** `127.0.0.1`, `::1`, `::ffff:127.0.0.1` and
 *      the IPv4-mapped forms are all the same address, and a blocklist that
 *      knows only the first is no defence.
 *   2. **Ranges rather than literals.** 169.254.0.0/16 is not one address, it
 *      is 65,536, and 169.254.169.254 is only the famous one.
 *   3. **Scheme and credential smuggling.** `file:`, `gopher:` and
 *      `https://user:pass@host` each get a credential or a filesystem read out
 *      of an address field.
 *   4. **The developer exemption is exactly that.** With `allowPrivate` on, a
 *      loopback target is permitted - and `env.ts` refuses to start a
 *      production process in that state, which is asserted in the env tests
 *      rather than here.
 */
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  assertSafeErpUrl,
  isPubliclyRoutable,
  resolveSafeTarget,
  safeFetch,
} from '../../src/infra/outbound-http.js';
import { AppError } from '../../src/domain/errors.js';

/** The code on the validation detail, which is what a form highlights. */
function refusalCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.details[0]?.code ?? error.code;
    throw error;
  }

  throw new Error('expected the address to be refused, and it was not');
}

describe('isPubliclyRoutable', () => {
  it.each([
    ['8.8.8.8', 'a public resolver'],
    ['1.1.1.1', 'another'],
    ['203.0.114.1', 'just outside TEST-NET-3'],
    ['2606:4700:4700::1111', 'public IPv6'],
  ])('accepts %s (%s)', (address) => {
    expect(isPubliclyRoutable(address)).toBe(true);
  });

  it.each([
    // Loopback, in each of the ways it is written.
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'the rest of 127/8, which is all loopback too'],
    ['0.0.0.0', 'the unspecified address, which routes to the local host'],
    ['::1', 'IPv6 loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback - the spelling a naive check misses'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata endpoint'],

    // Link-local: where every major cloud puts its instance credentials.
    ['169.254.169.254', 'the cloud metadata endpoint'],
    ['169.254.0.1', 'the rest of the link-local range'],
    ['fe80::1', 'IPv6 link-local'],

    // Private ranges.
    ['10.0.0.5', 'RFC 1918 /8'],
    ['172.16.0.1', 'RFC 1918 /12, lower bound'],
    ['172.31.255.254', 'RFC 1918 /12, upper bound'],
    ['192.168.1.1', 'RFC 1918 /16'],
    ['fd00::1', 'IPv6 unique local'],

    // Everything else that is not globally routable unicast.
    ['100.64.0.1', 'carrier-grade NAT - somebody else’s LAN on a shared host'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['198.18.0.1', 'benchmarking'],
    ['64:ff9b::7f00:1', 'NAT64, which translates straight back into v4 space'],
  ])('refuses %s (%s)', (address) => {
    expect(isPubliclyRoutable(address)).toBe(false);
  });

  it('refuses 172.32.0.1, which is outside RFC 1918 but looks like it is inside', () => {
    // The boundary that a `startsWith('172.')` check gets wrong in the other
    // direction: this one IS public, and refusing it would break a legitimate
    // customer.
    expect(isPubliclyRoutable('172.32.0.1')).toBe(true);
    expect(isPubliclyRoutable('172.15.0.1')).toBe(true);
  });

  it('refuses anything that is not an IP address at all', () => {
    expect(isPubliclyRoutable('erp.example.com')).toBe(false);
    expect(isPubliclyRoutable('')).toBe(false);
    expect(isPubliclyRoutable('not an address')).toBe(false);
  });
});

describe('assertSafeErpUrl', () => {
  it('accepts an ordinary HTTPS address', () => {
    const url = assertSafeErpUrl('https://erp.example.com/api/v2', { allowPrivate: false });
    expect(url.hostname).toBe('erp.example.com');
    expect(url.pathname).toBe('/api/v2');
  });

  it('refuses plain HTTP, because credentials travel on every request', () => {
    expect(refusalCode(() => assertSafeErpUrl('http://erp.example.com', { allowPrivate: false }))).toBe(
      'HTTPS_REQUIRED',
    );
  });

  it.each([
    ['file:///etc/passwd', 'a filesystem read dressed as an address'],
    ['gopher://erp.example.com/', 'a protocol that can forge arbitrary TCP payloads'],
    ['ftp://erp.example.com/', 'not a scheme this makes requests in'],
  ])('refuses %s (%s)', (candidate) => {
    expect(refusalCode(() => assertSafeErpUrl(candidate, { allowPrivate: false }))).toBe(
      'SCHEME_NOT_ALLOWED',
    );
  });

  it('refuses credentials embedded in the URL', () => {
    // Otherwise a password lands in a column meant to hold an address, where
    // masking does not reach it and every log line printing the URL prints the
    // password too.
    expect(
      refusalCode(() =>
        assertSafeErpUrl('https://admin:hunter2@erp.example.com/api', { allowPrivate: false }),
      ),
    ).toBe('CREDENTIALS_IN_URL');
  });

  it('refuses a literal private address without needing DNS', () => {
    expect(
      refusalCode(() => assertSafeErpUrl('https://169.254.169.254/latest/meta-data/', {
        allowPrivate: false,
      })),
    ).toBe('PRIVATE_ADDRESS');
  });

  it('refuses a query string on a base URL', () => {
    expect(
      refusalCode(() => assertSafeErpUrl('https://erp.example.com/api?tenant=7', {
        allowPrivate: false,
      })),
    ).toBe('BASE_URL_HAS_QUERY');
  });

  it('refuses something that is not a URL at all', () => {
    expect(refusalCode(() => assertSafeErpUrl('erp.example.com', { allowPrivate: false }))).toBe(
      'INVALID_URL',
    );
  });

  it('permits loopback and plain HTTP when a developer has opted in', () => {
    // The exemption exists for a mock ERP on localhost:9000, and `env.ts`
    // refuses to start a production process with it on.
    const url = assertSafeErpUrl('http://127.0.0.1:9000/erp', { allowPrivate: true });
    expect(url.port).toBe('9000');
  });
});

describe('resolveSafeTarget', () => {
  it('pins a literal public address without a DNS lookup', async () => {
    const target = await resolveSafeTarget(new URL('https://8.8.8.8/api'), {
      allowPrivate: false,
    });

    expect(target.address).toBe('8.8.8.8');
    expect(target.family).toBe(4);
  });

  it('refuses a hostname that resolves into loopback', async () => {
    // `localhost` is the case everybody remembers. It is here as the
    // representative of the general one: the check happens after resolution, so
    // a public hostname whose A record is 127.0.0.1 fails identically.
    await expect(
      resolveSafeTarget(new URL('https://localhost/api'), { allowPrivate: false }),
    ).rejects.toMatchObject({ code: 'ERP_URL_NOT_ALLOWED' });
  });

  it('resolves loopback when a developer has opted in', async () => {
    const target = await resolveSafeTarget(new URL('http://localhost:9000/erp'), {
      allowPrivate: true,
    });

    expect(['127.0.0.1', '::1']).toContain(target.address);
  });

  it('refuses a hostname that does not resolve', async () => {
    await expect(
      resolveSafeTarget(new URL('https://no-such-host.invalid/api'), { allowPrivate: false }),
    ).rejects.toMatchObject({ code: 'ERP_URL_NOT_ALLOWED' });
  });
});

/**
 * The pin, exercised against a real socket rather than described.
 *
 * Every other test in this file stops at `resolveSafeTarget` - it checks which
 * address the guard PICKS, which is the security question. None of them opened
 * a connection, and that gap hid a complete outage: the custom `lookup` that
 * enforces the pin answered Node's older `(err, address, family)` contract
 * only, while `net.connect` has asked with `{ all: true }` and expected an
 * ARRAY since Node 20 gained happy eyeballs. Node read `addresses[0].address`
 * off a string, got `undefined`, and failed every request with
 * `ERR_INVALID_IP_ADDRESS` - which reached the buyer as "Your system could not
 * be reached from here" about an ERP that was up and answering curl from the
 * same machine.
 *
 * So this one makes the request. A local server rather than a public host,
 * because a test that needs the internet is a test that fails on a train.
 */
describe('safeFetch against a real socket', () => {
  it('connects through the pinned lookup', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });

    // No host, so both address families answer - `localhost` resolves to ::1
    // first on some machines and 127.0.0.1 first on others, and the pin takes
    // whichever the guard picked.
    await new Promise<void>((resolve) => { server.listen(0, resolve); });

    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    try {
      // A HOSTNAME, not an IP literal: an IP short-circuits DNS and would never
      // reach the custom lookup, which is exactly the code under test.
      const result = await safeFetch(`http://localhost:${String(port)}/erp`, {
        method: 'GET',
        headers: {},
        timeoutMs: 5000,
        allowPrivate: true,
      });

      expect(result.status).toBe(200);
      expect(result.bodyText).toBe('{"ok":true}');
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  });
});
