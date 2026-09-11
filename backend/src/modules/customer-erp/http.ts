/**
 * One call to a buyer's own ERP.
 *
 * The seller-side connector next door (`integrations/erp-client.ts`) does the
 * same job for the operator's ERP, and this is deliberately not a shared
 * abstraction over both. They differ in every particular that matters: this one
 * has to speak six authentication methods rather than four, present a client
 * certificate, page through OData and GraphQL as well as REST, hold an
 * operator's host allowlist, and carry a different published error code so the
 * buyer's screens and the staff screens each render the message their own
 * catalogue has. Merging them would produce a function with two of everything
 * and a flag deciding which half runs.
 *
 * WHAT THIS FILE GUARANTEES
 *
 *   - Every request goes through `safeFetch`, which resolves the hostname
 *     itself, refuses private and link-local addresses, pins the socket to an
 *     address that passed, and re-validates every redirect target. A buyer
 *     types the address; that is the whole feature and also the whole risk.
 *   - Credentials are decrypted here, used to build one set of headers, and
 *     dropped. They are never returned, never logged, and never written into
 *     the ledger - `redactForLedger` is what the ledger sees.
 *   - A failure is CLASSIFIED before it is thrown, because the decisions differ
 *     entirely: AUTH means stop and tell the buyer to reauthorise, RATE_LIMIT
 *     means wait exactly as long as we were told, TRANSPORT means try again
 *     later, and REJECTED means the ERP understood us perfectly and said no,
 *     which no amount of retrying improves.
 */
import type {
  CustomerErpApiKeyLocation,
  CustomerErpAuthMethod,
} from '../../generated/prisma/enums.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import {
  OutboundRequestError,
  assertSafeErpUrl,
  safeFetch,
  type ClientCertificate,
  type SafeFetchResult,
} from '../../infra/outbound-http.js';
import {
  openCredential,
  type ClientCertificateCredential,
  type PrimaryCredential,
} from './credential.service.js';

export type AuthMethodName =
  | 'OAUTH2_CLIENT_CREDENTIALS'
  | 'OAUTH2_AUTHORIZATION_CODE'
  | 'API_KEY'
  | 'BEARER_TOKEN'
  | 'BASIC'
  | 'MONDAY_PERSONAL_TOKEN';

/**
 * The connection fields a call needs. Deliberately not the whole row.
 *
 * A narrow shape here is what stops this module reading, say, the policy and
 * quietly making a business decision. It builds a request and reads the answer;
 * everything else belongs to its caller.
 */
export interface ErpCallContext {
  id: string;
  organizationId: string;
  baseUrl: string;
  authMethod: AuthMethodName;
  apiKeyLocation: CustomerErpApiKeyLocation | null;
  apiKeyName: string | null;
  apiVersion: string | null;
  customHeaders: Record<string, string>;
  tenantIdentifier: string | null;
  timeoutMs: number;
  mutualTlsEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type ErpFailureKind =
  /// Credentials were refused. Retrying with the same ones is pointless.
  | 'AUTH'
  /// The ERP asked us to slow down. `retryAfterSeconds` says how long.
  | 'RATE_LIMIT'
  /// No answer at all: a timeout, a refused connection, a DNS failure.
  | 'TRANSPORT'
  /// The ERP failed on its own side. Worth another go later.
  | 'SERVER'
  /// The ERP understood and said no. A 400, a validation failure, a mapping it
  /// does not accept. Retrying changes nothing; a person has to.
  | 'REJECTED'
  /// It answered, and not with anything usable: not JSON, or JSON in a shape
  /// the mapping says should not exist.
  | 'UNUSABLE'
  /// The address itself is not one we will call.
  | 'BLOCKED';

export class ErpCallError extends Error {
  constructor(
    message: string,
    readonly kind: ErpFailureKind,
    readonly httpStatus: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ErpCallError';
  }

  /**
   * Whether trying again later could plausibly succeed.
   *
   * The one place this question is answered, so the dispatcher and the manual
   * retry cannot disagree about it. AUTH is deliberately false: an expired
   * credential does not un-expire, and six attempts against a system that has
   * said no six times is how a buyer's ERP starts rate-limiting us for real.
   */
  get isRetryable(): boolean {
    return this.kind === 'RATE_LIMIT' || this.kind === 'TRANSPORT' || this.kind === 'SERVER';
  }

  /** The published code a buyer's screen maps to a message. */
  get errorCode(): string {
    switch (this.kind) {
      case 'AUTH':
        return ErrorCode.CUSTOMER_ERP_AUTH_FAILED;
      case 'RATE_LIMIT':
        return ErrorCode.CUSTOMER_ERP_RATE_LIMITED;
      case 'UNUSABLE':
        return ErrorCode.CUSTOMER_ERP_RESPONSE_UNUSABLE;
      case 'BLOCKED':
        return ErrorCode.CUSTOMER_ERP_URL_NOT_ALLOWED;
      case 'TRANSPORT':
      case 'SERVER':
      case 'REJECTED':
        return ErrorCode.SERVICE_UNAVAILABLE;
    }
  }
}

/**
 * A message safe to store and show.
 *
 * Everything that reaches a buyer's screen, their audit log or the ledger comes
 * through here. An ERP's own error body can contain the credential it just
 * refused - some of them echo the Authorization header back in a "malformed
 * token: Bearer eyJ..." message - so nothing is passed through verbatim.
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof ErpCallError) return error.message;

  if (error instanceof OutboundRequestError) {
    switch (error.code) {
      case 'TIMEOUT':
        return 'Your system did not respond in time.';
      case 'UNREACHABLE':
        return 'Your system could not be reached from here.';
      case 'TOO_MANY_REDIRECTS':
        return 'That address redirected too many times.';
      case 'RESPONSE_TOO_LARGE':
        return 'Your system sent more data than we can accept in one response.';
    }
  }

  return 'The request to your system did not complete.';
}

/**
 * `Retry-After`, in seconds.
 *
 * Comes in two forms - a delay in seconds, or an HTTP date - and both turn up
 * in the wild. Honouring it matters: an ERP that says "wait 300 seconds" and
 * gets another request in five has been told, by our behaviour, that its rate
 * limiting does not work, and the next thing it does is block us properly.
 */
export function parseRetryAfter(value: string | undefined): number | null {
  if (value === undefined) return null;

  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    // A day is already absurd. Deferring somebody's purchase order until next
    // month because a header said so is not honouring a rate limit.
    return Number.isFinite(seconds) ? Math.min(seconds, 86_400) : null;
  }

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;

  const seconds = Math.ceil((asDate - Date.now()) / 1000);
  return seconds > 0 ? Math.min(seconds, 86_400) : null;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Keys whose values never reach `requestJson` or `responseJson`.
 *
 * The ledger exists so a disagreement about a purchase order can be settled by
 * what was actually exchanged. That is worth keeping and it is not worth
 * keeping a credential for, so the key survives and the value does not.
 */
const SECRET_KEY_PATTERN =
  /(secret|password|token|apikey|api_key|authorization|credential|passphrase|privatekey|private_key|signature)/i;

export function redactForLedger(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]';
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    // Capped: a ledger row is evidence, not a copy of the feed.
    return value.slice(0, 100).map((entry) => redactForLedger(entry, depth + 1));
  }

  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY_PATTERN.test(key)
      ? '[redacted]'
      : redactForLedger(entry, depth + 1);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Endpoint URLs
// ---------------------------------------------------------------------------

/** The operator's allowlist, or undefined when there is none. */
export function hostPolicy(): readonly string[] | undefined {
  return env.CUSTOMER_ERP_ALLOWED_HOST_SUFFIXES.length > 0
    ? env.CUSTOMER_ERP_ALLOWED_HOST_SUFFIXES
    : undefined;
}

/**
 * Turn a configured path into an absolute URL on the connection's own origin.
 *
 * A path may be relative (`/api/purchase-orders`) or absolute
 * (`https://erp.example.com/api/purchase-orders`), and an absolute one is
 * accepted only if it is on the SAME ORIGIN as the base URL. That restriction
 * is the point of this function: an "endpoint" free to name a different host is
 * a server-side request forgery primitive with a form field in front of it, and
 * the base URL is the only address the buyer has been asked to justify.
 *
 * Checked at save time so a typo is a form error, and again here because
 * nothing guarantees the row was written by the path that validates.
 */
export function resolveEndpointUrl(
  baseUrl: string,
  path: string,
  field = 'path',
): URL {
  const base = new URL(ensureTrailingSlash(baseUrl));

  let resolved: URL;
  try {
    // `new URL(path, base)` handles both shapes: a relative path resolves
    // against the base, an absolute one replaces it - which is exactly the case
    // the origin check below exists to catch.
    resolved = new URL(path.replace(/^\/+/, ''), base);
  } catch {
    throw badRequest(ErrorCode.CUSTOMER_ERP_ENDPOINT_OFF_ORIGIN, 'That path is not valid.', [
      { field, code: 'INVALID_PATH' },
    ]);
  }

  if (resolved.origin !== base.origin) {
    throw badRequest(
      ErrorCode.CUSTOMER_ERP_ENDPOINT_OFF_ORIGIN,
      'An endpoint has to be on the same address as the connection itself. Change the ' +
        'connection address if your system is somewhere else.',
      [{ field, code: 'OFF_ORIGIN' }],
    );
  }

  return resolved;
}

function ensureTrailingSlash(url: string): string {
  const parsed = new URL(url);
  if (!parsed.pathname.endsWith('/')) parsed.pathname = `${parsed.pathname}/`;
  return parsed.toString();
}

/**
 * A URL an ERP handed back - an OData `@odata.nextLink`, a `next` in a paging
 * envelope - checked before it is followed.
 *
 * The same origin rule, for the same reason and with more force: this address
 * was not typed by anybody, it arrived in a response body. A paging link that
 * may point anywhere is a way for a compromised or hostile ERP to make this
 * server fetch an address of its choosing, with the buyer's credentials
 * attached.
 */
export function assertSameOriginLink(baseUrl: string, link: string): URL {
  const base = new URL(baseUrl);

  let resolved: URL;
  try {
    resolved = new URL(link, base);
  } catch {
    throw new ErpCallError(
      'Your system sent a paging link that is not a valid address.',
      'UNUSABLE',
    );
  }

  if (resolved.origin !== base.origin) {
    throw new ErpCallError(
      'Your system sent a paging link pointing at a different address, which we do not ' +
        'follow.',
      'BLOCKED',
    );
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

const USER_AGENT = 'UBOSS-Customer-ERP/1.0';

/**
 * Headers a buyer may not set through `customHeadersJson`.
 *
 * Not a style rule. `Authorization` set from a column the API returns would put
 * a credential in a read path; `Host` and `Content-Length` set by hand break
 * the request in ways that look like the ERP's fault.
 */
const RESERVED_HEADERS = new Set([
  'authorization',
  'host',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
  'cookie',
  'user-agent',
  'accept-encoding',
]);

export function isConfigurableHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (RESERVED_HEADERS.has(lower)) return false;
  // A header name is a token; anything else is somebody trying to inject a
  // second header by putting a newline in the first.
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name);
}

export interface BuildHeadersOptions {
  hasBody: boolean;
  /** Supplied by the caller for an OAuth connection; obtained once per job. */
  accessToken?: string | null;
  idempotencyKey?: string | null;
  idempotencyHeader?: string;
  accept?: string;
}

/**
 * Build one request's headers, decrypting the credential to do it.
 *
 * Returns the query parameters an API-key-in-query connection needs alongside
 * them, because the alternative is this function returning headers and the
 * caller separately remembering to ask where the key goes.
 */
export async function buildHeaders(
  context: ErpCallContext,
  options: BuildHeadersOptions,
): Promise<{ headers: Record<string, string>; query: Record<string, string> }> {
  const headers: Record<string, string> = {
    accept: options.accept ?? 'application/json',
    'user-agent': USER_AGENT,
  };

  const query: Record<string, string> = {};

  if (options.hasBody) headers['content-type'] = 'application/json';

  // The buyer's own non-secret headers: a company code, an API version, a
  // subscription tier. Filtered rather than trusted.
  for (const [name, value] of Object.entries(context.customHeaders)) {
    if (!isConfigurableHeader(name)) continue;
    headers[name.toLowerCase()] = String(value).slice(0, 1024);
  }

  if (options.idempotencyKey !== null && options.idempotencyKey !== undefined) {
    headers[(options.idempotencyHeader ?? 'Idempotency-Key').toLowerCase()] =
      options.idempotencyKey;
  }

  const primary = await openCredential<PrimaryCredential>(context.id, 'PRIMARY');

  switch (context.authMethod) {
    case 'OAUTH2_CLIENT_CREDENTIALS':
    case 'OAUTH2_AUTHORIZATION_CODE': {
      // The token is obtained by `oauth.service.ts` and passed in, once per
      // job rather than once per request: a client-credentials round trip
      // before every read would double both the traffic and the failure
      // surface.
      if (options.accessToken === null || options.accessToken === undefined) {
        throw new ErpCallError(
          'This connection has no valid authorisation. Reconnect it.',
          'AUTH',
        );
      }
      headers['authorization'] = `Bearer ${options.accessToken}`;
      break;
    }
    case 'API_KEY': {
      const key = primary?.apiKey;
      if (key === undefined || context.apiKeyName === null) {
        throw new ErpCallError('No API key is configured for this connection.', 'AUTH');
      }

      if (context.apiKeyLocation === 'QUERY') {
        query[context.apiKeyName] = key;
      } else {
        headers[context.apiKeyName.toLowerCase()] = key;
      }
      break;
    }
    case 'BEARER_TOKEN': {
      if (primary?.bearerToken === undefined) {
        throw new ErpCallError('No token is configured for this connection.', 'AUTH');
      }
      headers['authorization'] = `Bearer ${primary.bearerToken}`;
      break;
    }
    case 'BASIC': {
      if (primary?.username === undefined || primary.password === undefined) {
        throw new ErpCallError(
          'No username and password are configured for this connection.',
          'AUTH',
        );
      }
      headers['authorization'] = `Basic ${Buffer.from(
        `${primary.username}:${primary.password}`,
        'utf8',
      ).toString('base64')}`;
      break;
    }
    case 'MONDAY_PERSONAL_TOKEN': {
      if (primary?.personalToken === undefined) {
        throw new ErpCallError('No personal token is configured for this connection.', 'AUTH');
      }
      // monday accepts the token bare in `Authorization`, without a scheme.
      headers['authorization'] = primary.personalToken;
      break;
    }
  }

  // A second secret alongside the first: a gateway subscription key, an SAP
  // routing token. Kept in the vault rather than in `customHeadersJson`
  // precisely so it can be applied here without ever being returned.
  for (const [name, value] of Object.entries(primary?.secretHeaders ?? {})) {
    if (!isConfigurableHeader(name)) continue;
    headers[name.toLowerCase()] = value;
  }

  if (context.apiVersion !== null && context.apiVersion.length > 0) {
    headers['api-version'] ??= context.apiVersion;
  }

  return { headers, query };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface ErpRequest {
  url: URL;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Serialised as JSON. Omitted for a GET. */
  body?: unknown;
  accessToken?: string | null;
  idempotencyKey?: string | null;
  idempotencyHeader?: string;
  query?: Record<string, string>;
  accept?: string;
  maxResponseBytes?: number;
  /**
   * Headers the CONNECTOR adds, after the credential headers are built.
   *
   * For the one protocol requirement no amount of configuration can express:
   * SAP's OData services hand out a CSRF token and a session cookie on a read
   * and refuse the write that follows without both. Filtered through
   * `isConfigurableHeader` like anything else, so a connector cannot overwrite
   * `Authorization` by accident either.
   */
  extraHeaders?: Record<string, string>;
  /** Sent as one `Cookie` header. Same reason as above. */
  cookies?: readonly string[];
}

export interface ErpResponse<T = unknown> {
  status: number;
  /** Parsed JSON, or null when the body was empty or was not JSON. */
  data: T | null;
  /** The raw body, capped. Kept for the "it was not JSON" diagnosis. */
  rawBody: string;
  headers: Record<string, string>;
  /** Unjoined, so multiple cookies can be sent back. */
  setCookie: string[];
  durationMs: number;
  finalUrl: string;
}

/**
 * Make one attempt.
 *
 * Throws `ErpCallError` for everything that is not a usable answer, classified
 * so the caller can decide what to do. A 2xx with an unparseable body is NOT an
 * error here: plenty of ERPs answer a successful POST with an empty 204, and
 * `data: null` is the honest representation of that.
 *
 * Retries are not done here, deliberately. One call, one answer; the backoff,
 * the attempt ceiling and the dead-letter state belong to the dispatcher, which
 * is the only thing that knows whether this event has been tried five times
 * already.
 */
export async function callErp<T = unknown>(
  context: ErpCallContext,
  request: ErpRequest,
): Promise<ErpResponse<T>> {
  const hasBody = request.method !== 'GET' && request.body !== undefined;

  const { headers, query } = await buildHeaders(context, {
    hasBody,
    accessToken: request.accessToken ?? null,
    idempotencyKey: request.idempotencyKey ?? null,
    ...(request.idempotencyHeader === undefined
      ? {}
      : { idempotencyHeader: request.idempotencyHeader }),
    ...(request.accept === undefined ? {} : { accept: request.accept }),
  });

  // Applied AFTER the credential headers, and filtered like any other
  // configurable header - so a connector cannot overwrite `Authorization`, and
  // a header name carrying a newline cannot smuggle a second header in.
  for (const [name, value] of Object.entries(request.extraHeaders ?? {})) {
    if (!isConfigurableHeader(name)) continue;
    headers[name.toLowerCase()] = String(value).slice(0, 4096);
  }

  if (request.cookies !== undefined && request.cookies.length > 0) {
    // Only the `name=value` part of each `Set-Cookie`. The attributes - Path,
    // Secure, HttpOnly, SameSite - are instructions to a browser and mean
    // nothing on the way back.
    headers['cookie'] = request.cookies
      .map((cookie) => cookie.split(';')[0]?.trim() ?? '')
      .filter((cookie) => cookie.length > 0)
      .join('; ');
  }

  const url = new URL(request.url.toString());
  for (const [name, value] of Object.entries({ ...(request.query ?? {}), ...query })) {
    url.searchParams.set(name, value);
  }

  // Validated once more immediately before the call. The row may have been
  // written by a migration, a support script, or a code path added after this
  // one; "it was checked when it was saved" is a claim about history.
  assertSafeErpUrl(url.toString(), {
    field: 'baseUrl',
    // A request URL: the path is joined on and the paging cursor is already in
    // the query string by this point.
    allowQuery: true,
    errorCode: ErrorCode.CUSTOMER_ERP_URL_NOT_ALLOWED,
    ...(hostPolicy() === undefined ? {} : { allowedHostSuffixes: hostPolicy() as string[] }),
  });

  const certificate = context.mutualTlsEnabled
    ? await loadClientCertificate(context.id)
    : undefined;

  let result: SafeFetchResult;

  try {
    result = await safeFetch(url.toString(), {
      method: request.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
      timeoutMs: context.timeoutMs,
      field: 'baseUrl',
      errorCode: ErrorCode.CUSTOMER_ERP_URL_NOT_ALLOWED,
      maxResponseBytes: request.maxResponseBytes ?? env.CUSTOMER_ERP_MAX_RESPONSE_BYTES,
      ...(hostPolicy() === undefined ? {} : { allowedHostSuffixes: hostPolicy() }),
      ...(certificate === undefined ? {} : { clientCertificate: certificate }),
    });
  } catch (error) {
    if (error instanceof OutboundRequestError) {
      throw new ErpCallError(safeErrorMessage(error), 'TRANSPORT');
    }
    // A validation refusal from the address checks. Rethrown as itself so the
    // route can render its field detail.
    throw error;
  }

  const retryAfter = parseRetryAfter(result.headers['retry-after']);

  if (result.status === 401 || result.status === 403) {
    throw new ErpCallError(
      'Your system refused our credentials. Check them, or reconnect the authorisation.',
      'AUTH',
      result.status,
    );
  }

  if (result.status === 429) {
    throw new ErpCallError(
      retryAfter === null
        ? 'Your system asked us to slow down.'
        : `Your system asked us to wait ${retryAfter} seconds.`,
      'RATE_LIMIT',
      result.status,
      retryAfter,
    );
  }

  if (result.status >= 500) {
    throw new ErpCallError(
      `Your system reported an error of its own (HTTP ${result.status}).`,
      'SERVER',
      result.status,
      retryAfter,
    );
  }

  if (result.status >= 400) {
    throw new ErpCallError(
      `Your system rejected the request (HTTP ${result.status}). ` +
        'This usually means a field it needs is missing or mapped to the wrong name.',
      'REJECTED',
      result.status,
    );
  }

  return {
    status: result.status,
    data: parseJson<T>(result.bodyText),
    rawBody: result.bodyText,
    headers: result.headers,
    setCookie: result.setCookie,
    durationMs: result.durationMs,
    finalUrl: result.finalUrl,
  };
}

/**
 * The same call, but a 4xx is returned rather than thrown.
 *
 * For the handful of places where a rejection IS the answer: a 409 on a
 * document number means the ERP already has it, which is a success as far as
 * the pipeline is concerned. `callErp` throwing on every 4xx is right for
 * everything else, and a connector that wants to look at the status itself
 * should have to say so.
 */
export async function callErpAllowingRejection<T = unknown>(
  context: ErpCallContext,
  request: ErpRequest,
): Promise<ErpResponse<T> | { rejected: true; status: number; body: string }> {
  try {
    return await callErp<T>(context, request);
  } catch (error) {
    if (error instanceof ErpCallError && error.kind === 'REJECTED' && error.httpStatus !== null) {
      return { rejected: true, status: error.httpStatus, body: error.message };
    }
    throw error;
  }
}

function parseJson<T>(body: string): T | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

async function loadClientCertificate(
  connectionId: string,
): Promise<ClientCertificate | undefined> {
  const stored = await openCredential<ClientCertificateCredential>(
    connectionId,
    'CLIENT_CERTIFICATE',
  );

  if (stored === null) {
    throw new ErpCallError(
      'This connection is set to use a client certificate, but none is installed.',
      'AUTH',
    );
  }

  return {
    certificatePem: stored.certificatePem,
    privateKeyPem: stored.privateKeyPem,
    ...(stored.passphrase === undefined ? {} : { passphrase: stored.passphrase }),
  };
}

/** Convert the database enum to the union this module uses. */
export function toAuthMethodName(method: CustomerErpAuthMethod): AuthMethodName {
  return method;
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/**
 * When to try again.
 *
 * Exponential from a configured base, capped, and OVERRIDDEN entirely whenever
 * the ERP told us how long to wait. Jitter of up to a quarter of the delay,
 * because a hundred events queued by one outage otherwise all wake at the same
 * instant and reproduce it.
 */
export function backoffMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000;

  const base = env.CUSTOMER_ERP_RETRY_BASE_SECONDS * 1000;
  const capped = Math.min(base * 2 ** Math.max(0, attempt - 1), env.CUSTOMER_ERP_RETRY_MAX_SECONDS * 1000);

  return Math.round(capped * (1 + Math.random() * 0.25));
}
