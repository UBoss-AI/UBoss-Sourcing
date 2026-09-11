/**
 * Calling a URL somebody else typed.
 *
 * Everywhere else in this system, the addresses we call are ours: a payment
 * gateway named in configuration, an SMTP host an administrator set. This
 * module exists for the one case where that is not true. An administrator
 * connects an ERP under Settings -> ERP, and the base URL, the endpoint paths
 * and the token endpoint all arrive in a form field. The server then makes an
 * authenticated HTTP request to whatever they wrote.
 *
 * Being administrator-typed makes an address more likely to be right. It does
 * not make it right - a copied URL, a compromised account or a hostname whose
 * DNS answer changes are all still on the table - and the guard costs nothing.
 *
 * That is a server-side request forgery primitive with a text input in front of
 * it, and the defence cannot be a blocklist of hostnames. `localhost` is the
 * least interesting way to reach the loopback interface; `127.1`, `0x7f.1`,
 * `[::ffff:127.0.0.1]`, a DNS name whose A record is 127.0.0.1, and a public
 * host that 302s to `http://169.254.169.254/latest/meta-data/iam/` are all the
 * same attack wearing different clothes.
 *
 * So the rule here is about ADDRESSES, applied after resolution, at every hop:
 *
 *   1. Parse the URL. Only http and https exist; `file:`, `gopher:`, `data:`
 *      and the rest are refused by scheme rather than by pattern.
 *   2. Resolve the hostname to actual IP addresses, ourselves, before
 *      connecting.
 *   3. Reject every address that is not globally routable unicast - loopback,
 *      link-local (which is where cloud metadata lives), every private range,
 *      CGNAT, multicast, broadcast, unspecified, and their IPv4-mapped IPv6
 *      spellings.
 *   4. Pin the connection to an address that passed. Resolving and then handing
 *      the hostname to `fetch` re-resolves it, and a DNS server under the
 *      attacker's control can answer differently the second time - the classic
 *      TOCTOU rebind. `lookup` on the agent is what closes that.
 *   5. Follow no redirects automatically. A redirect is a fresh URL that has
 *      not been through steps 1-4, so it is returned to the caller, re-checked,
 *      and followed a bounded number of times or not at all.
 *
 * One deliberate exception, and it is narrow. A developer running this on their
 * own machine has to be able to point a connection at a mock ERP on
 * `localhost:9000`. `ALLOW_PRIVATE_ERP_TARGETS` permits exactly that, it
 * defaults to false, and `env.ts` refuses to start a production process with it
 * on. It is not reachable by anything a customer can send.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { env } from '../config/env.js';
import { ErrorCode, badRequest, type ErrorCodeValue } from '../domain/errors.js';

/** How many bytes of a response we are willing to hold in memory. */
export const MAX_OUTBOUND_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Redirects followed, at most, and only after re-validating each target. */
const MAX_REDIRECTS = 3;

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/**
 * Is this IPv4 address globally routable unicast?
 *
 * Written as arithmetic on the four octets rather than string matching,
 * because `127.0.0.1`, `127.1`, `2130706433` and `0x7f000001` are all the same
 * address and only one of them looks like it. Node has already normalised the
 * spelling by the time an address reaches here; the ranges below are what
 * actually decides.
 */
function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((value) => Number.isNaN(value))) return false;

  const [a = 0, b = 0] = octets;

  // 0.0.0.0/8 - "this network". 0.0.0.0 itself routes to the local host on
  // most stacks, which is the whole problem.
  if (a === 0) return false;
  // 10.0.0.0/8
  if (a === 10) return false;
  // 127.0.0.0/8 - loopback, all sixteen million of them.
  if (a === 127) return false;
  // 169.254.0.0/16 - link-local. 169.254.169.254 is the cloud metadata
  // endpoint on AWS, GCP, Azure and DigitalOcean alike, and it is the single
  // most valuable address an SSRF can reach.
  if (a === 169 && b === 254) return false;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return false;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return false;
  // 192.0.0.0/24 (IETF protocol assignments) and 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0) return false;
  // 100.64.0.0/10 - carrier-grade NAT. Not private, not public, and on a
  // shared host it is somebody else's LAN.
  if (a === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127) return false;
  // 198.18.0.0/15 - benchmarking.
  if (a === 198 && (b === 18 || b === 19)) return false;
  // 198.51.100.0/24 (TEST-NET-2) and 203.0.113.0/24 (TEST-NET-3)
  if (a === 198 && b === 51 && (octets[2] ?? 0) === 100) return false;
  if (a === 203 && b === 0 && (octets[2] ?? 0) === 113) return false;
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast.
  if (a >= 224) return false;

  return true;
}

/**
 * Is this IPv6 address globally routable unicast?
 *
 * The IPv4-mapped case matters more than it looks: `::ffff:127.0.0.1` is a
 * perfectly ordinary way to spell the loopback, and a check that only knew
 * about `::1` would wave it through.
 */
function isPublicIpv6(address: string): boolean {
  const value = address.toLowerCase().split('%')[0] ?? '';

  // Unspecified and loopback.
  if (value === '::' || value === '::1') return false;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d). Both carry a
  // v4 address that has to be judged as one.
  const mapped = /^::(?:ffff:(?:0{1,4}:)?)?(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped?.[1] !== undefined) return isPublicIpv4(mapped[1]);

  // fc00::/7 - unique local.
  if (/^f[cd]/.test(value)) return false;
  // fe80::/10 - link-local, and the v6 spelling of the metadata endpoint.
  if (/^fe[89ab]/.test(value)) return false;
  // ff00::/8 - multicast.
  if (value.startsWith('ff')) return false;
  // 2001:db8::/32 - documentation.
  if (value.startsWith('2001:db8')) return false;
  // 64:ff9b::/96 - NAT64, which translates straight back into v4 space.
  if (value.startsWith('64:ff9b')) return false;

  return true;
}

/** True when an address is one we are willing to open a socket to. */
export function isPubliclyRoutable(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

export interface SafeUrlOptions {
  /** Field name for the validation error, so a form can highlight the input. */
  field?: string;
  /**
   * Whether this URL is a REQUEST url rather than a base address.
   *
   * A base URL with a query string is almost always a mistake - it is a
   * setting, and `?page=1` stored in it would be silently carried onto every
   * call - so the default is false and the rule below refuses it.
   *
   * A request URL is the opposite: paging puts its cursor in a query parameter
   * on every style this platform speaks, so `/inventory?page=2` is the normal
   * shape of a perfectly ordinary read. `safeFetch` sets this, because by the
   * time a URL reaches it, it has already been built from a base and a path.
   *
   * A `#fragment` stays refused either way. It is never sent on the wire, so
   * one in a URL this code is about to call means something built it wrong.
   */
  allowQuery?: boolean;
  /**
   * Permit loopback and private targets. Set only from
   * `env.ALLOW_PRIVATE_ERP_TARGETS`, which cannot be true in production.
   */
  allowPrivate?: boolean;
  /**
   * An operator's allowlist of host suffixes, on top of everything else.
   *
   * Empty or absent means "any publicly routable host", which is what the
   * address checks already enforce and is the right posture for a product sold
   * to businesses whose ERPs live at addresses nobody here can predict. An
   * operator with a stricter policy supplies a list and every buyer is held to
   * it. A leading dot means "this domain and its subdomains"; anything else is
   * an exact host.
   *
   * A second lock on top of the address rules, never a replacement for them: a
   * hostname on the list still has to resolve to a public address, and still
   * has that address pinned.
   */
  allowedHostSuffixes?: readonly string[];
  /**
   * Which published error code a refusal carries.
   *
   * The seller's ERP screens and the buyer's account screens map codes to
   * messages separately, so a refusal from one must not arrive wearing the
   * other's code. Defaults to the seller's, which is what every existing
   * caller expects.
   */
  errorCode?: ErrorCodeValue;
}

/**
 * Does this host satisfy an operator's allowlist?
 *
 * Exported because the endpoint check needs the same answer without repeating
 * the suffix semantics, and two implementations of "is this host allowed" is
 * one implementation too many.
 */
export function hostMatchesPolicy(
  hostname: string,
  allowedHostSuffixes: readonly string[],
): boolean {
  if (allowedHostSuffixes.length === 0) return true;

  const host = hostname.toLowerCase();

  return allowedHostSuffixes.some((entry) =>
    entry.startsWith('.')
      ? // `.example.com` admits `erp.example.com` and `example.com` itself,
        // because an operator who lists a domain means the domain.
        host === entry.slice(1) || host.endsWith(entry)
      : host === entry,
  );
}

export interface ResolvedTarget {
  url: URL;
  /** The address the socket will actually be opened to. */
  address: string;
  family: 4 | 6;
}

function reject(
  message: string,
  code: string,
  field: string,
  errorCode: ErrorCodeValue = ErrorCode.ERP_URL_NOT_ALLOWED,
): never {
  throw badRequest(errorCode, message, [{ field, code }]);
}

/**
 * Parse and check a URL a customer supplied, without resolving it.
 *
 * The cheap half of the check, run at save time so a typo is a form error
 * rather than a job that fails an hour later. `resolveSafeTarget` does the
 * expensive half - DNS - and is run again immediately before every request,
 * because passing this once is not a promise about what the name resolves to
 * later.
 */
export function assertSafeErpUrl(rawUrl: string, options: SafeUrlOptions = {}): URL {
  const field = options.field ?? 'baseUrl';
  const allowPrivate = options.allowPrivate ?? env.ALLOW_PRIVATE_ERP_TARGETS;

  // Carries the caller's error code into every refusal below, so the seller's
  // screens and the buyer's screens each get the code their catalogue maps.
  const refuse: (message: string, code: string, refusalField: string) => never = (
    message,
    code,
    refusalField,
  ) => reject(message, code, refusalField, options.errorCode);

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    refuse('Enter a full URL, including https://.', 'INVALID_URL', field);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    refuse('Only http and https addresses can be used.', 'SCHEME_NOT_ALLOWED', field);
  }

  // Credentials travel on every request this URL is used for. Plain HTTP puts
  // them on the wire in front of anybody on the path.
  if (parsed.protocol !== 'https:' && !allowPrivate) {
    refuse(
      'The address must use HTTPS. Your credentials are sent with every request.',
      'HTTPS_REQUIRED',
      field,
    );
  }

  // `https://user:pass@erp.example.com` would put a credential in a column
  // meant to hold an address, where masking does not reach it and every log
  // line that prints the URL prints the password too.
  if (parsed.username !== '' || parsed.password !== '') {
    refuse(
      'Put the username and password in the authentication section, not in the URL.',
      'CREDENTIALS_IN_URL',
      field,
    );
  }

  if (parsed.hostname === '') {
    refuse('The address is missing a host name.', 'HOST_MISSING', field);
  }

  // A literal IP that is already private fails here without a DNS round trip.
  // A hostname is left to `resolveSafeTarget`.
  if (isIP(parsed.hostname) !== 0 && !allowPrivate && !isPubliclyRoutable(parsed.hostname)) {
    refuse(
      'That address is on a private or reserved network and cannot be reached from here.',
      'PRIVATE_ADDRESS',
      field,
    );
  }

  // A query string on a BASE url is almost always a mistake, and keeping it out
  // means path joining has one obvious meaning. On a REQUEST url it is how
  // every paging style this platform speaks carries its cursor, so the rule is
  // asked of base addresses only - see `allowQuery`.
  if (parsed.search !== '' && options.allowQuery !== true) {
    refuse(
      'The base address should not include a query string or a #fragment.',
      'BASE_URL_HAS_QUERY',
      field,
    );
  }

  // A fragment is refused either way: it is never sent on the wire, so one here
  // means whatever built this URL built it wrong.
  if (parsed.hash !== '') {
    refuse(
      'That address should not include a #fragment.',
      'BASE_URL_HAS_QUERY',
      field,
    );
  }

  // The operator's allowlist, where there is one. Checked here so a typo is a
  // form error rather than a job that fails an hour later, and checked again in
  // `resolveSafeTarget` because passing this once says nothing about the
  // redirect targets that follow.
  if (
    options.allowedHostSuffixes !== undefined &&
    !hostMatchesPolicy(parsed.hostname, options.allowedHostSuffixes)
  ) {
    refuse(
      'That address is outside the list of systems this store is allowed to call. ' +
        'Ask your supplier which addresses are permitted.',
      'HOST_NOT_ALLOWED',
      field,
    );
  }

  return parsed;
}

/**
 * Resolve a hostname and pick an address we are willing to talk to.
 *
 * Every address the name resolves to has to pass, not merely the first: a
 * hostname answering with both a public address and 127.0.0.1 is a rebind
 * attempt wearing a round-robin costume, and picking whichever came first would
 * make the outcome a coin toss.
 */
export async function resolveSafeTarget(
  url: URL,
  options: SafeUrlOptions = {},
): Promise<ResolvedTarget> {
  const field = options.field ?? 'baseUrl';
  const allowPrivate = options.allowPrivate ?? env.ALLOW_PRIVATE_ERP_TARGETS;

  const refuse: (message: string, code: string, refusalField: string) => never = (
    message,
    code,
    refusalField,
  ) => reject(message, code, refusalField, options.errorCode);

  // Re-checked here as well as at save time, because this function is what runs
  // immediately before every request and a redirect target arrives here having
  // been through nothing else. An operator's allowlist that only applied to the
  // address somebody typed would be no allowlist at all.
  if (
    options.allowedHostSuffixes !== undefined &&
    !hostMatchesPolicy(url.hostname, options.allowedHostSuffixes)
  ) {
    refuse(
      'That address is outside the list of systems this store is allowed to call. ' +
        'Ask your supplier which addresses are permitted.',
      'HOST_NOT_ALLOWED',
      field,
    );
  }

  if (isIP(url.hostname) !== 0) {
    if (!allowPrivate && !isPubliclyRoutable(url.hostname)) {
      refuse(
        'That address is on a private or reserved network and cannot be reached from here.',
        'PRIVATE_ADDRESS',
        field,
      );
    }
    return { url, address: url.hostname, family: isIP(url.hostname) === 6 ? 6 : 4 };
  }

  let addresses: LookupAddress[];
  try {
    addresses = await dnsLookup(url.hostname, { all: true, verbatim: true });
  } catch {
    refuse(
      'That host name could not be looked up. Check the spelling and that it is reachable.',
      'DNS_LOOKUP_FAILED',
      field,
    );
  }

  if (addresses.length === 0) {
    refuse('That host name resolved to no addresses.', 'DNS_NO_RESULT', field);
  }

  if (!allowPrivate) {
    // Every answer, not the first. See the note above.
    const offending = addresses.find((entry) => !isPubliclyRoutable(entry.address));
    if (offending !== undefined) {
      refuse(
        'That host name resolves to a private or reserved network address and cannot be ' +
          'reached from here.',
        'PRIVATE_ADDRESS',
        field,
      );
    }
  }

  const chosen = addresses[0];
  if (chosen === undefined) {
    refuse('That host name resolved to no addresses.', 'DNS_NO_RESULT', field);
  }

  return { url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

// ---------------------------------------------------------------------------
// The request itself
// ---------------------------------------------------------------------------

/**
 * A client certificate to present during the TLS handshake.
 *
 * Some ERPs - SAP landscapes behind a corporate gateway most of all -
 * authenticate the CALLER with a certificate rather than, or as well as, a
 * token. The PEM bytes come out of the credential vault and live in memory for
 * the duration of one request; nothing here writes them anywhere.
 */
export interface ClientCertificate {
  certificatePem: string;
  privateKeyPem: string;
  passphrase?: string;
}

export interface SafeFetchOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  allowPrivate?: boolean;
  /** Field name used if the URL turns out to be unacceptable. */
  field?: string;
  maxResponseBytes?: number;
  /** An operator allowlist, applied to the target and to every redirect. */
  allowedHostSuffixes?: readonly string[];
  /** Which published error code a refusal carries. */
  errorCode?: ErrorCodeValue;
  /**
   * Mutual TLS. Ignored for a plain-HTTP target, which cannot have a handshake
   * to present it in - and which `assertSafeErpUrl` has already refused unless
   * the deployment is a developer's own machine.
   */
  clientCertificate?: ClientCertificate;
}

export interface SafeFetchResult {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /**
   * `Set-Cookie`, unjoined.
   *
   * Its own field because it is the one header that legitimately appears more
   * than once and whose values contain commas, so the joined form in `headers`
   * cannot be split back apart. Needed by exactly one caller - SAP's OData
   * services hand out a session cookie alongside the CSRF token and refuse the
   * write that follows without both - and empty for everybody else.
   */
  setCookie: string[];
  /** Truncated at `maxResponseBytes`; `truncated` says whether that happened. */
  bodyText: string;
  truncated: boolean;
  durationMs: number;
  /** The URL actually fetched, after any redirects we chose to follow. */
  finalUrl: string;
}

/**
 * A transport-level failure - no response, a timeout, a refused connection.
 *
 * Distinct from an HTTP error status, which `safeFetch` returns rather than
 * throws: a 404 from an ERP is an answer, and the caller decides what it means.
 */
export class OutboundRequestError extends Error {
  constructor(
    message: string,
    readonly code: 'TIMEOUT' | 'UNREACHABLE' | 'TOO_MANY_REDIRECTS' | 'RESPONSE_TOO_LARGE',
  ) {
    super(message);
    this.name = 'OutboundRequestError';
  }
}

/**
 * One hop, to an address that has already been validated.
 *
 * Built on `node:http`/`node:https` rather than `fetch`, and that is the load-
 * bearing decision in this module. `fetch` gives no way to say which IP the
 * socket opens to: it re-resolves the hostname itself, which reopens exactly
 * the DNS-rebind window that `resolveSafeTarget` just closed. The classic
 * `node:http` request accepts a `lookup` function, and the one below returns
 * the address we already checked without consulting DNS a second time.
 *
 * TLS is unaffected: `servername` stays the hostname from the URL, so SNI and
 * certificate verification work exactly as they would against a virtual host.
 */
function requestOnce(
  target: ResolvedTarget,
  options: SafeFetchOptions,
  maxBytes: number,
): Promise<Omit<SafeFetchResult, 'durationMs'>> {
  return new Promise((resolve, rejectPromise) => {
    const isHttps = target.url.protocol === 'https:';
    const transport = isHttps ? httpsRequest : httpRequest;

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const request = transport(
      target.url,
      {
        method: options.method,
        headers: options.headers,
        // The pin. Called instead of DNS when the socket is opened.
        lookup: (_hostname, _lookupOptions, callback) => {
          (callback as (err: null, address: string, family: number) => void)(
            null,
            target.address,
            target.family,
          );
        },
        // SNI and certificate verification still key off the real hostname.
        ...(isHttps ? { servername: target.url.hostname } : {}),
        // Mutual TLS, where the connection carries a certificate. `rejectUnauthorized`
        // is deliberately left at its default of true: presenting our own
        // certificate is no reason to stop checking theirs, and an option that
        // turned that off would be the single most dangerous line in this file.
        ...(isHttps && options.clientCertificate !== undefined
          ? {
              cert: options.clientCertificate.certificatePem,
              key: options.clientCertificate.privateKeyPem,
              ...(options.clientCertificate.passphrase === undefined
                ? {}
                : { passphrase: options.clientCertificate.passphrase }),
            }
          : {}),
      },
      (response) => {
        const headers: Record<string, string> = {};
        const setCookie: string[] = [];

        for (const [key, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;

          if (key.toLowerCase() === 'set-cookie') {
            setCookie.push(...(Array.isArray(value) ? value : [value]));
          }

          headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;

        response.on('data', (chunk: Buffer) => {
          if (truncated) return;

          if (total + chunk.byteLength > maxBytes) {
            // Keep the prefix - it usually carries the error the ERP is trying
            // to tell us - and stop reading. Streamed rather than buffered so a
            // two-gigabyte answer costs a truncated string, not this process.
            chunks.push(chunk.subarray(0, maxBytes - total));
            truncated = true;
            response.destroy();
            return;
          }

          chunks.push(chunk);
          total += chunk.byteLength;
        });

        const complete = (): void => {
          finish(() => {
            resolve({
              status: response.statusCode ?? 0,
              headers,
              setCookie,
              bodyText: Buffer.concat(chunks).toString('utf8'),
              truncated,
              finalUrl: target.url.toString(),
            });
          });
        };

        response.on('end', complete);
        // `destroy()` above ends the stream with 'close' and no 'end'. A
        // truncated body is still an answer, so it resolves rather than throws.
        response.on('close', complete);

        response.on('error', () => {
          finish(() => {
            rejectPromise(
              new OutboundRequestError(
                'The connection closed before the response finished.',
                'UNREACHABLE',
              ),
            );
          });
        });
      },
    );

    // Covers connect, headers and body together. `request.setTimeout` only
    // watches for socket inactivity, so a server dribbling one byte a second
    // would keep a worker slot for ever under that alone.
    const hardTimer = setTimeout(() => {
      finish(() => {
        request.destroy();
        rejectPromise(
          new OutboundRequestError('The system did not respond in time.', 'TIMEOUT'),
        );
      });
    }, options.timeoutMs);

    request.setTimeout(options.timeoutMs, () => {
      finish(() => {
        request.destroy();
        rejectPromise(
          new OutboundRequestError('The system did not respond in time.', 'TIMEOUT'),
        );
      });
    });

    request.on('error', () => {
      finish(() => {
        rejectPromise(
          new OutboundRequestError(
            'The system could not be reached. Check the address and that it accepts ' +
              'connections from the internet.',
            'UNREACHABLE',
          ),
        );
      });
    });

    request.on('close', () => {
      clearTimeout(hardTimer);
    });

    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/**
 * One outbound request to a customer-supplied address.
 *
 * Validates, resolves, pins, sends, and caps what comes back. Redirects are
 * never followed automatically: a `Location` is a fresh URL that has been
 * through none of the checks above, so it goes back to the top of this loop and
 * is validated and re-resolved like any other, at most `MAX_REDIRECTS` times.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const allowPrivate = options.allowPrivate ?? env.ALLOW_PRIVATE_ERP_TARGETS;
  const maxBytes = options.maxResponseBytes ?? MAX_OUTBOUND_RESPONSE_BYTES;
  const field = options.field ?? 'baseUrl';
  const startedAt = Date.now();

  let currentUrl = rawUrl;
  let bodyForHop = options.body;
  let methodForHop = options.method;

  // Everything the two validators need, assembled once so the redirect loop
  // cannot accidentally apply a weaker policy on a later hop than the first.
  const urlOptions: SafeUrlOptions = {
    field,
    allowPrivate,
    // What arrives here is a REQUEST url - a base address with a path and,
    // wherever the endpoint pages, a cursor in a query parameter. The
    // no-query-string rule belongs to the address a customer TYPES, and is
    // applied there, at save time.
    allowQuery: true,
    ...(options.allowedHostSuffixes === undefined
      ? {}
      : { allowedHostSuffixes: options.allowedHostSuffixes }),
    ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
  };

  for (let hop = 0; ; hop += 1) {
    const parsed = assertSafeErpUrl(currentUrl, urlOptions);
    const target = await resolveSafeTarget(parsed, urlOptions);

    const hopOptions: SafeFetchOptions = {
      ...options,
      method: methodForHop,
      ...(bodyForHop === undefined ? {} : { body: bodyForHop }),
      // Whatever is left of the caller's budget. A chain of three slow hops
      // must not cost three times the timeout the customer configured.
      timeoutMs: Math.max(1000, options.timeoutMs - (Date.now() - startedAt)),
    };

    const result = await requestOnce(target, hopOptions, maxBytes);

    if (result.status < 300 || result.status >= 400) {
      return { ...result, durationMs: Date.now() - startedAt };
    }

    const location = result.headers['location'];
    if (location === undefined || location === '') {
      // A redirect with nowhere to go. Returned as the malformed answer it is,
      // rather than dressed up as an error of ours.
      return { ...result, durationMs: Date.now() - startedAt };
    }

    if (hop >= MAX_REDIRECTS) {
      throw new OutboundRequestError('The address redirected too many times.', 'TOO_MANY_REDIRECTS');
    }

    // 303, and 301/302 in practice, turn the follow-up into a GET with no body.
    // Replaying a POST body to a URL the first server chose is how a redirect
    // becomes a way to make this server submit somebody's order somewhere else.
    if (result.status === 303 || result.status === 301 || result.status === 302) {
      methodForHop = 'GET';
      bodyForHop = undefined;
    }

    currentUrl = new URL(location, parsed).toString();
  }
}
