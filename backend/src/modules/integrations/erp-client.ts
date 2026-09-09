/**
 * Talking to one customer's ERP.
 *
 * Everything that puts bytes on the wire towards a buyer's own system goes
 * through here, so four things are decided once rather than in each caller:
 *
 *   **Authentication.** Four methods, one shape. API key, bearer, basic and
 *   OAuth 2.0 client credentials all end up as headers, and only this module
 *   decrypts a credential to build them. The plaintext exists inside one
 *   function, is never returned, never logged, and never reaches an error.
 *
 *   **Where a request may go.** `safeFetch` resolves the hostname, refuses
 *   every private and reserved address, pins the socket to an address that
 *   passed, and re-validates each redirect. An endpoint path is joined to the
 *   base URL and checked to be on the same origin, so "endpoint" cannot become
 *   "somewhere else entirely".
 *
 *   **What comes back.** Bounded in bytes, parsed defensively, and classified:
 *   an ERP saying 401 is a different situation from an ERP saying 500 and a
 *   different one again from an ERP not answering, and each wants a different
 *   response from us. `ErpCallError.kind` is that classification.
 *
 *   **What a customer is told.** `safeErrorMessage` is the only thing that
 *   writes an error into a column a customer reads. A provider body can contain
 *   a bearer token the ERP echoed back, a stack trace, or a connection string;
 *   none of that goes anywhere near an Activity screen.
 *
 * Retries do NOT live here. This module makes one attempt and reports what
 * happened; the caller decides whether trying again is appropriate, because the
 * answer differs completely between a stock poll (drop it, the next one is in
 * an hour) and a paid order that has not reached the warehouse (retry for
 * hours, under the same key).
 */
import { Buffer } from 'node:buffer';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { decryptSecret } from '../../infra/crypto.js';
import {
  MAX_OUTBOUND_RESPONSE_BYTES,
  OutboundRequestError,
  assertSafeErpUrl,
  safeFetch,
} from '../../infra/outbound-http.js';

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** AAD binding a credential ciphertext to the row that holds it. */
export function erpCredentialAad(connectionId: string): string {
  return `erp_connection:${connectionId}`;
}

/**
 * What a customer typed into the authentication section, by method.
 *
 * Stored as one encrypted JSON object rather than a column each, because the
 * shape depends on `authMethod` and half the columns would always be NULL. The
 * cost is that reading one field means decrypting all of them, which is the
 * right trade: they are read together, in this file, and nowhere else.
 */
export interface ErpCredentials {
  /** API_KEY: the header to put it in, and the key itself. */
  headerName?: string;
  apiKey?: string;
  /** BEARER_TOKEN */
  token?: string;
  /** BASIC */
  username?: string;
  password?: string;
  /** OAUTH2 */
  clientId?: string;
  clientSecret?: string;
  /**
   * Header name -> value, for an ERP wanting a second secret alongside the
   * first. Separated from `customHeadersJson` on the connection because these
   * are secrets and that column is returned by the API.
   */
  extraSecretHeaders?: Record<string, string>;
}

export type ErpAuthMethodName = 'API_KEY' | 'BEARER_TOKEN' | 'BASIC' | 'OAUTH2';

/** The connection fields this module needs. Deliberately not the whole row. */
export interface ErpCallContext {
  id: string;
  baseUrl: string;
  authMethod: ErpAuthMethodName;
  credentialsEnc: string | null;
  customHeaders: Record<string, string>;
  timeoutMs: number;
  /** OAuth only. */
  oauthTokenUrl: string | null;
  oauthScope: string | null;
  oauthTokenEnc: string | null;
  oauthTokenExpiresAt: Date | null;
}

/**
 * Decrypt a connection's credentials.
 *
 * Returns an empty object rather than throwing when there are none: a
 * connection may legitimately be mid-setup, and the request that follows will
 * fail against the ERP with a 401 that says so far more usefully than an
 * exception here would.
 */
export function decryptErpCredentials(context: ErpCallContext): ErpCredentials {
  if (context.credentialsEnc === null) return {};

  try {
    return JSON.parse(
      decryptSecret(context.credentialsEnc, erpCredentialAad(context.id)),
    ) as ErpCredentials;
  } catch {
    // A ciphertext that will not open is an operational fault - a rotated key,
    // a row copied between environments - and it must not surface as the
    // credential itself. The caller gets "authentication is not configured".
    return {};
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * What went wrong, in the terms the caller actually needs to branch on.
 *
 * `kind` rather than a status code because the decisions differ: AUTH means
 * stop and tell the customer to check their credentials, RATE_LIMIT means wait
 * exactly as long as we were told, TRANSPORT means try again later, and
 * REJECTED means the ERP understood us perfectly and said no - which no amount
 * of retrying improves.
 */
export type ErpFailureKind =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TRANSPORT'
  | 'SERVER'
  | 'REJECTED'
  | 'UNUSABLE_RESPONSE';

export class ErpCallError extends Error {
  constructor(
    /** Already safe to show a customer. */
    message: string,
    readonly kind: ErpFailureKind,
    readonly httpStatus: number | null = null,
    /** Seconds, from a Retry-After header. Only ever set on RATE_LIMIT. */
    readonly retryAfterSeconds: number | null = null,
    /** Redacted and size-capped. For the ledger, not for the customer. */
    readonly responseSnippet: unknown = null,
  ) {
    super(message);
    this.name = 'ErpCallError';
  }

  /**
   * Is another attempt worth making?
   *
   * REJECTED and AUTH are false: the ERP understood the request and refused it,
   * and sending the identical bytes again gets the identical answer while
   * looking, from the customer's side, like a system hammering their server.
   */
  get retryable(): boolean {
    return this.kind === 'TRANSPORT' || this.kind === 'SERVER' || this.kind === 'RATE_LIMIT';
  }

  /** The code stored on the ledger row. */
  get errorCode(): string {
    if (this.httpStatus !== null) return `HTTP_${String(this.httpStatus)}`;
    return this.kind;
  }
}

/**
 * Turn anything into a sentence safe to store where a customer will read it.
 *
 * The rule: describe the SITUATION, never quote the provider. An ERP's error
 * body is written by somebody else's software and routinely contains the
 * Authorization header it just rejected, a SQL fragment, a stack trace, or an
 * internal hostname. None of that belongs in a column the Activity screen
 * renders, and "sanitise it on the way out" is a promise every future reader of
 * that column would have to keep.
 *
 * The safe half of what the ERP said - a status code, a round-trip time -
 * travels in its own typed fields, where it cannot be mistaken for prose.
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof ErpCallError) return error.message;

  if (error instanceof OutboundRequestError) {
    switch (error.code) {
      case 'TIMEOUT':
        return 'Your ERP did not respond in time.';
      case 'TOO_MANY_REDIRECTS':
        return 'The address redirected too many times.';
      case 'RESPONSE_TOO_LARGE':
        return 'Your ERP sent more data than this connection accepts.';
      default:
        return 'Your ERP could not be reached.';
    }
  }

  // Deliberately not `error.message`. An arbitrary throw from anywhere in the
  // request path can carry a URL with a token in it.
  return 'The request to the ERP could not be completed.';
}

/**
 * A response body, redacted and capped, for the ledger.
 *
 * Kept because a disagreement about an order is settled by what was actually
 * exchanged. Redacted because ERPs echo credentials: `Authorization`,
 * `X-API-Key` and friends turn up inside error bodies more often than anybody
 * would like.
 */
const SECRET_KEY_PATTERN =
  /(authorization|api[-_]?key|secret|password|token|credential|passwd|bearer)/i;

export function redactForLedger(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[nested too deeply]';

  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => redactForLedger(entry, depth + 1));
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    let count = 0;

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (count >= 50) {
        output['...'] = '[truncated]';
        break;
      }
      count += 1;

      output[key] = SECRET_KEY_PATTERN.test(key)
        ? '[redacted]'
        : redactForLedger(entry, depth + 1);
    }

    return output;
  }

  return null;
}

// ---------------------------------------------------------------------------
// URL assembly
// ---------------------------------------------------------------------------

/**
 * Join an endpoint to a base URL, refusing anything that leaves the origin.
 *
 * Somebody types `/api/v2/stock` and means a path. They may also paste
 * `https://erp.example.com/api/v2/stock`, which is the same place written out,
 * and refusing that would be pedantry. What must be refused is
 * `https://evil.example/collect` in the endpoint field of a connection whose
 * base URL is the ERP - because that turns a per-endpoint setting into a way to
 * point one authenticated request somewhere else.
 *
 * So: relative paths are joined, absolute URLs are permitted only on the base
 * URL's own origin, and anything else is a validation error against the field
 * it was typed into.
 */
export function resolveEndpointUrl(
  baseUrl: string,
  endpoint: string,
  field: string,
): string {
  const base = assertSafeErpUrl(baseUrl, { field: 'baseUrl' });

  const trimmed = endpoint.trim();
  if (trimmed === '') {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'This endpoint has not been set.', [
      { field, code: 'ENDPOINT_MISSING' },
    ]);
  }

  let resolved: URL;
  try {
    // A relative path resolves against the base; an absolute URL replaces it,
    // which is exactly the case the origin check below exists for.
    resolved = new URL(trimmed, ensureTrailingSlash(base));
  } catch {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'This endpoint is not a valid path or URL.', [
      { field, code: 'ENDPOINT_INVALID' },
    ]);
  }

  if (resolved.origin !== base.origin) {
    throw badRequest(
      ErrorCode.ERP_ENDPOINT_OFF_ORIGIN,
      'An endpoint has to be on the same server as the base address. Change the base address ' +
        'if the endpoint really is somewhere else.',
      [{ field, code: 'OFF_ORIGIN' }],
    );
  }

  return resolved.toString();
}

/**
 * A base URL ending in `/`, so `new URL('stock', base)` keeps the base path.
 *
 * Without it, a base of `https://erp.example.com/api/v2` and an endpoint of
 * `stock` resolve to `https://erp.example.com/api/stock` - the last segment is
 * treated as a filename and dropped. That silently drops a path segment the
 * customer typed, and the resulting 404 looks like their ERP's fault.
 */
function ensureTrailingSlash(url: URL): URL {
  if (url.pathname.endsWith('/')) return url;
  const copy = new URL(url.toString());
  copy.pathname = `${copy.pathname}/`;
  return copy;
}

// ---------------------------------------------------------------------------
// OAuth 2.0
// ---------------------------------------------------------------------------

export interface OAuthToken {
  accessToken: string;
  expiresAt: Date;
}

/**
 * A client-credentials access token.
 *
 * Client credentials rather than any interactive grant, because there is no
 * human present: a stock poll runs at 03:00 and an order push runs inside a
 * webhook handler. An authorization-code flow would need somebody at a browser
 * both times.
 *
 * The secret goes in the body rather than a Basic header. RFC 6749 permits
 * either and requires servers to support the header; in practice more ERPs
 * accept the body form, and it is the one that works against the widest set of
 * things a customer might have.
 *
 * The caller caches what comes back - see `oauthTokenEnc` on the connection.
 * Fetching a token before each request would double both the traffic and the
 * number of ways a stock read can fail.
 */
export async function fetchOAuthToken(context: ErpCallContext): Promise<OAuthToken> {
  const credentials = decryptErpCredentials(context);

  if (
    context.oauthTokenUrl === null ||
    credentials.clientId === undefined ||
    credentials.clientSecret === undefined
  ) {
    throw new ErpCallError(
      'The OAuth client ID, secret or token address is missing from this connection.',
      'AUTH',
    );
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    ...(context.oauthScope === null || context.oauthScope === ''
      ? {}
      : { scope: context.oauthScope }),
  }).toString();

  let response;
  try {
    response = await safeFetch(context.oauthTokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body,
      timeoutMs: context.timeoutMs,
      field: 'oauthTokenUrl',
      // A token response is small. A large one is a misconfigured URL pointing
      // at something that is not a token endpoint.
      maxResponseBytes: 64 * 1024,
    });
  } catch (error) {
    throw new ErpCallError(safeErrorMessage(error), 'TRANSPORT');
  }

  if (response.status === 401 || response.status === 403 || response.status === 400) {
    // 400 belongs here rather than with REJECTED: `invalid_client` is the
    // OAuth-specified answer to a wrong secret, and it arrives as a 400.
    throw new ErpCallError(
      'Your ERP refused the OAuth client ID and secret.',
      'AUTH',
      response.status,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw new ErpCallError(
      'The OAuth token address did not return a token.',
      'SERVER',
      response.status,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.bodyText);
  } catch {
    throw new ErpCallError(
      'The OAuth token address did not return JSON.',
      'UNUSABLE_RESPONSE',
      response.status,
    );
  }

  const payload = parsed as { access_token?: unknown; expires_in?: unknown };
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : null;

  if (accessToken === null || accessToken === '') {
    throw new ErpCallError(
      'The OAuth token address answered without an access token.',
      'UNUSABLE_RESPONSE',
      response.status,
    );
  }

  // A minute of slack. A token that expires while a request is in flight fails
  // in a way that looks exactly like a wrong secret, and an hour of debugging
  // is a poor price for sixty seconds of validity.
  const expiresIn =
    typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
      ? Math.max(60, Math.floor(payload.expires_in))
      : 3600;

  return {
    accessToken,
    expiresAt: new Date(Date.now() + (expiresIn - 60) * 1000),
  };
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * Identifies this software to the customer's ERP.
 *
 * Worth sending: the person reading their ERP's access log should be able to
 * tell what has been calling it every hour, and an unlabelled agent is the kind
 * of thing that gets blocked by a firewall rule at 2am.
 */
const USER_AGENT = 'UBOSS-ERP-Connector/1.0';

/**
 * Header names a customer's `customHeadersJson` may not set.
 *
 * Not a matter of taste. Letting a custom header overwrite `Authorization`
 * would let somebody paste a credential into a column the API returns in plain
 * text, and letting one set the idempotency header would break the guarantee
 * that a retry cannot duplicate an order.
 */
const RESERVED_HEADERS = new Set([
  'authorization',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'cookie',
  'user-agent',
]);

/** Is this a header name a customer may configure? */
export function isConfigurableHeader(name: string, idempotencyHeader: string): boolean {
  const lower = name.toLowerCase();
  if (RESERVED_HEADERS.has(lower)) return false;
  if (lower === idempotencyHeader.toLowerCase()) return false;
  // RFC 7230 token. A header name with a newline in it is header injection.
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) && name.length <= 64;
}

/**
 * Every header one request carries.
 *
 * The only place a decrypted credential becomes a header value, and it is
 * returned rather than stored: the object lives for the duration of one call.
 */
async function buildHeaders(
  context: ErpCallContext,
  options: { idempotencyKey?: string; idempotencyHeader?: string; hasBody: boolean },
  oauthAccessToken: string | null,
): Promise<Record<string, string>> {
  const credentials = decryptErpCredentials(context);

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    ...(options.hasBody ? { 'Content-Type': 'application/json' } : {}),
  };

  // Customer-configured headers first, so nothing below can be overwritten by
  // one - `isConfigurableHeader` already refused the dangerous names at save
  // time, and this ordering means a future addition to that list is safe even
  // against rows saved before it.
  for (const [name, value] of Object.entries(context.customHeaders)) {
    if (!isConfigurableHeader(name, options.idempotencyHeader ?? 'Idempotency-Key')) continue;
    headers[name] = value;
  }

  switch (context.authMethod) {
    case 'API_KEY': {
      const headerName = credentials.headerName ?? 'X-API-Key';
      if (credentials.apiKey !== undefined && isConfigurableHeader(headerName, '')) {
        headers[headerName] = credentials.apiKey;
      }
      break;
    }

    case 'BEARER_TOKEN':
      if (credentials.token !== undefined) {
        headers['Authorization'] = `Bearer ${credentials.token}`;
      }
      break;

    case 'BASIC':
      if (credentials.username !== undefined) {
        headers['Authorization'] = `Basic ${Buffer.from(
          `${credentials.username}:${credentials.password ?? ''}`,
          'utf8',
        ).toString('base64')}`;
      }
      break;

    case 'OAUTH2':
      if (oauthAccessToken !== null) {
        headers['Authorization'] = `Bearer ${oauthAccessToken}`;
      }
      break;
  }

  for (const [name, value] of Object.entries(credentials.extraSecretHeaders ?? {})) {
    if (!isConfigurableHeader(name, options.idempotencyHeader ?? 'Idempotency-Key')) continue;
    headers[name] = value;
  }

  // Last, so nothing can displace it. This header is what makes a retry safe.
  if (options.idempotencyKey !== undefined) {
    headers[options.idempotencyHeader ?? 'Idempotency-Key'] = options.idempotencyKey;
  }

  return Promise.resolve(headers);
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface ErpCallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** Sent as JSON. Omitted entirely for a GET. */
  body?: unknown;
  idempotencyKey?: string;
  idempotencyHeader?: string;
  /** An OAuth token the caller has already obtained and cached. */
  oauthAccessToken?: string | null;
  maxResponseBytes?: number;
}

export interface ErpCallResult<T = unknown> {
  status: number;
  /** Parsed JSON, or null when the body was empty or not JSON. */
  data: T | null;
  /** The raw body, capped. Kept for the "not JSON" diagnosis. */
  rawBody: string;
  durationMs: number;
  headers: Record<string, string>;
}

/**
 * `Retry-After`, in seconds.
 *
 * The header comes in two forms - a delay in seconds, or an HTTP date - and
 * both turn up in the wild. Honouring it matters: an ERP that says "wait 300
 * seconds" and gets another request in five has been told, by our behaviour,
 * that its rate limiting does not work, and the next thing it does is block us.
 */
export function parseRetryAfter(value: string | undefined): number | null {
  if (value === undefined) return null;

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    // A day is already absurd; anything longer is a misconfiguration, and
    // deferring a customer's stock sync until next month is not a kindness.
    return Number.isFinite(seconds) ? Math.min(seconds, 86_400) : null;
  }

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;

  const seconds = Math.ceil((asDate - Date.now()) / 1000);
  return seconds > 0 ? Math.min(seconds, 86_400) : null;
}

/**
 * One call to a customer's ERP.
 *
 * Makes one attempt. Throws `ErpCallError` for everything that is not a usable
 * answer, classified so the caller can decide what to do about it. A 2xx with
 * an unparseable body is NOT an error here - some ERPs answer a successful POST
 * with an empty 204, and `data: null` is the honest representation of that.
 */
export async function callErp<T = unknown>(
  context: ErpCallContext,
  url: string,
  options: ErpCallOptions,
): Promise<ErpCallResult<T>> {
  const hasBody = options.method !== 'GET' && options.body !== undefined;

  const headers = await buildHeaders(
    context,
    {
      hasBody,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      ...(options.idempotencyHeader === undefined
        ? {}
        : { idempotencyHeader: options.idempotencyHeader }),
    },
    options.oauthAccessToken ?? null,
  );

  let response;
  try {
    response = await safeFetch(url, {
      method: options.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      timeoutMs: context.timeoutMs,
      field: 'baseUrl',
      maxResponseBytes: options.maxResponseBytes ?? MAX_OUTBOUND_RESPONSE_BYTES,
    });
  } catch (error) {
    throw new ErpCallError(safeErrorMessage(error), 'TRANSPORT');
  }

  let data: unknown = null;
  if (response.bodyText.trim() !== '') {
    try {
      data = JSON.parse(response.bodyText);
    } catch {
      data = null;
    }
  }

  // --- Classify --------------------------------------------------------

  if (response.status === 401 || response.status === 403) {
    throw new ErpCallError(
      'Your ERP refused these credentials. Check the authentication details and try the test ' +
        'again.',
      'AUTH',
      response.status,
      null,
      redactForLedger(data),
    );
  }

  if (response.status === 429) {
    throw new ErpCallError(
      'Your ERP asked us to slow down. The next attempt will wait as long as it asked.',
      'RATE_LIMIT',
      429,
      parseRetryAfter(response.headers['retry-after']),
      redactForLedger(data),
    );
  }

  if (response.status >= 500) {
    throw new ErpCallError(
      'Your ERP reported an internal error.',
      'SERVER',
      response.status,
      null,
      redactForLedger(data),
    );
  }

  if (response.status >= 400) {
    // A 409 is not handled here. It is meaningful only for an order push -
    // where it means "I already have this" - and that meaning belongs to the
    // caller who knows an idempotency key was sent.
    throw new ErpCallError(
      `Your ERP rejected the request with status ${String(response.status)}.`,
      'REJECTED',
      response.status,
      null,
      redactForLedger(data),
    );
  }

  if (response.truncated) {
    throw new ErpCallError(
      'Your ERP sent more data than this connection accepts. Narrow the request, or use paging.',
      'UNUSABLE_RESPONSE',
      response.status,
    );
  }

  return {
    status: response.status,
    data: data as T | null,
    rawBody: response.bodyText,
    durationMs: response.durationMs,
    headers: response.headers,
  };
}

/**
 * The per-attempt ceiling for a configured ERP connection.
 *
 * Read from configuration rather than fixed, and lower than the environment
 * connector's, for a reason worth stating: these attempts land on a server
 * somebody else operates. An ERP that has refused six times is telling its
 * owner something, and continuing past that is a decision about their
 * infrastructure this system should not take on their behalf.
 */
export function maxAttempts(): number {
  return env.ERP_MAX_ATTEMPTS;
}

/**
 * How long to wait before attempt number `attempt`.
 *
 * Exponential with full jitter: 1, 2, 4, 8... minutes, each multiplied by a
 * random factor between 0.5 and 1. The jitter is not decoration - without it,
 * a hundred connections knocked out by one network blip all retry at the same
 * instant, and the recovering ERP is hit by exactly the thundering herd that
 * kept it down.
 *
 * A `Retry-After` the ERP sent always wins. It asked for a specific delay and
 * an exponential guess is not a better answer than the one we were given.
 */
export function backoffMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000;

  const base = Math.min(2 ** Math.max(0, attempt - 1), 64) * 60_000;
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}
