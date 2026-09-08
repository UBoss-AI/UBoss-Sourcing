/**
 * The API client.
 *
 * Every request goes through here, so the rules the backend enforces are
 * honoured in exactly one place:
 *
 *   - **Cookies, not tokens.** Access and refresh tokens are httpOnly; this
 *     code cannot read them and must not try. `credentials: 'include'` is
 *     mandatory on every call, including the cross-origin ones in development.
 *   - **Double-submit CSRF.** `uboss_csrf` is the one cookie readable by
 *     JavaScript. Its value is copied into `x-csrf-token` on every unsafe
 *     method. Forget it and every write returns FORBIDDEN.
 *   - **One refresh at a time.** A 401 triggers a single refresh, shared by
 *     every request that hit 401 together. One refresh per in-flight request
 *     rotates the refresh token repeatedly and the backend's reuse detection
 *     kills the session — logging out a customer mid-checkout.
 *   - **Idempotency keys pass through unchanged.** Checkout and payment
 *     creation require one. It is generated once per attempt by the caller and
 *     reused across retries of that attempt; a fresh key per retry is exactly
 *     the duplicate-order bug the header exists to prevent.
 *   - **The error envelope is the contract.** `{ error: { code, message,
 *     details, correlationId } }`. `ApiError` carries all four.
 */

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1').replace(
  /\/+$/,
  '',
);

// Scoped to this surface. A cookie is identified by name, domain and path -
// not by port - so the admin panel and the storefront share one jar whenever
// they sit on the same hostname. Shared names meant signing into one
// silently signed you out of the other.
const CSRF_COOKIE = 'uboss_shop_csrf';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiErrorDetail {
  field?: string;
  code?: string;
  message?: string;
  meta?: Record<string, unknown>;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: ApiErrorDetail[];
  correlationId?: string;
}

/** A failed request, carrying everything the UI needs to explain it. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetail[];
  readonly correlationId: string | null;
  /** Seconds to wait, when the server said so. Only set on a 429. */
  readonly retryAfterSeconds: number | null;

  constructor(status: number, body: ApiErrorBody, retryAfterSeconds: number | null = null) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details ?? [];
    this.correlationId = body.correlationId ?? null;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** Field-keyed messages, ready for `setError` on a react-hook-form. */
  fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {};

    for (const detail of this.details) {
      if (detail.field === undefined) continue;
      result[detail.field] ??= detail.message ?? this.message;
    }

    return result;
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** 5xx and 503 specifically — the request may succeed if tried again later. */
  get isServerFault(): boolean {
    return this.status >= 500;
  }
}

/** A transport failure — no response at all. Distinct from a 4xx or 5xx. */
export class NetworkError extends Error {
  readonly isOffline: boolean;

  constructor(message: string, isOffline: boolean) {
    super(message);
    this.name = 'NetworkError';
    this.isOffline = isOffline;
  }
}

function readCsrfToken(): string | null {
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`));

  if (match === undefined) return null;

  return decodeURIComponent(match.slice(CSRF_COOKIE.length + 1));
}

/**
 * Listeners notified when the session ends unrecoverably.
 *
 * The session provider subscribes and clears its customer, so a dead session
 * shows a sign-in prompt rather than a page of failing panels.
 */
type SessionEndedListener = () => void;
const sessionEndedListeners = new Set<SessionEndedListener>();

export function onSessionEnded(listener: SessionEndedListener): () => void {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}

function announceSessionEnded(): void {
  for (const listener of sessionEndedListeners) listener();
}

/** The in-flight refresh, shared by every request that hit 401 together. */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async (): Promise<boolean> => {
    try {
      const csrf = readCsrfToken();
      const response = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: csrf === null ? {} : { [CSRF_HEADER]: csrf },
      });
      return response.ok;
    } catch {
      // A refresh that could not reach the server is not a dead session. The
      // caller reports the network failure instead of signing the user out.
      return false;
    } finally {
      // Cleared in a microtask so every caller awaiting this promise observes
      // the same result before a new refresh can start.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /**
   * An array is sent as one repeated parameter per entry (`?attr=a&attr=b`),
   * which is how a catalogue facet with several values ticked crosses the
   * wire. An empty array sends nothing.
   */
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
  signal?: AbortSignal;
  /**
   * Sent as `Idempotency-Key`. Required by the backend on checkout and payment
   * creation. Generate it once per attempt and reuse it across retries of that
   * attempt — see `newIdempotencyKey`.
   */
  idempotencyKey?: string;
  /** Internal: prevents a refreshed request from refreshing again. */
  retryOnUnauthorised?: boolean;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  // The second argument is what lets BASE_URL be relative ("/api/v1"), which is
  // how the app is served through an HTTPS tunnel: the API then sits on whatever
  // origin the page was loaded from. An absolute BASE_URL ignores it.
  const url = new URL(
    `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`,
    window.location.origin,
  );

  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      // Undefined and null mean "no filter", which is not the same as an empty
      // string — `?q=` would filter on the empty string.
      if (value === undefined || value === null || value === '') continue;

      if (Array.isArray(value)) {
        // Appended, never set: each entry is its own occurrence of the key,
        // and `set` would leave only the last one standing.
        for (const entry of value) {
          if (entry !== '') url.searchParams.append(key, entry);
        }
        continue;
      }

      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  return await response.text();
}

function toApiError(status: number, body: unknown, retryAfter: string | null): ApiError {
  const retryAfterSeconds =
    retryAfter === null || !/^\d+$/.test(retryAfter) ? null : Number(retryAfter);

  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'object'
  ) {
    return new ApiError(status, (body as { error: ApiErrorBody }).error, retryAfterSeconds);
  }

  // A response that is not the envelope means something upstream answered — a
  // proxy, a gateway, a maintenance page. Say that rather than inventing a code.
  //
  // The English below is a last resort, not what a customer reads: this module
  // has no `t`, so `lib/errors.ts` matches on the *code* and words both of
  // these in the page's own language. Keep the codes and the wording in step
  // with the two branches there.
  return new ApiError(
    status,
    {
      code: status === 503 ? 'SERVICE_UNAVAILABLE' : 'UNEXPECTED_RESPONSE',
      message:
        status === 503
          ? 'The store is temporarily unavailable. Please try again in a few minutes.'
          : `The server returned an unexpected ${String(status)} response.`,
    },
    retryAfterSeconds,
  );
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (!SAFE_METHODS.has(method)) {
    const csrf = readCsrfToken();
    if (csrf !== null) headers[CSRF_HEADER] = csrf;
  }

  if (options.idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  let body: BodyInit | undefined;

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;

  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      credentials: 'include',
      headers,
      ...(body === undefined ? {} : { body }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;

    // `navigator.onLine` is only reliable when it says false, which is exactly
    // the case worth distinguishing: "you are offline" is actionable, "the
    // server could not be reached" is not.
    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;

    // Worded in English for the same reason, and translated the same way -
    // `errorMessage` reads `isOffline`, never this string.
    throw new NetworkError(
      isOffline
        ? 'You appear to be offline. Check your connection and try again.'
        : 'Could not reach the store. Please try again.',
      isOffline,
    );
  }

  if (response.ok) {
    return (await parseBody(response)) as T;
  }

  const payload = await parseBody(response);

  if (response.status === 401 && (options.retryOnUnauthorised ?? true)) {
    const refreshed = await refreshSession();

    if (refreshed) {
      return request<T>(path, { ...options, retryOnUnauthorised: false });
    }

    announceSessionEnded();
  }

  throw toApiError(response.status, payload, response.headers.get('retry-after'));
}

/**
 * A POST whose response is read as a stream rather than parsed.
 *
 * `request` above cannot serve this: it reads the whole body before it
 * returns, which for Server-Sent Events means waiting for the last token to
 * arrive before showing the first. The assistant panel needs the raw
 * `Response` so it can read `response.body` frame by frame.
 *
 * Everything else this module promises still applies, and that is the reason
 * this lives here rather than in the caller: `credentials: 'include'`, the
 * double-submit CSRF header, and one shared refresh on a 401 with the session
 * announced as ended when the refresh fails. A component doing its own
 * `fetch` would quietly opt out of all three - and a streaming endpoint
 * behind a sign-in is exactly where a missed refresh looks like a dropped
 * connection instead of an expired session.
 *
 * Returns the response whatever its status. A streaming caller has to see the
 * 401 itself: it may have a half-typed message to keep hold of, which no
 * thrown error could carry back.
 */
export async function requestStream(
  path: string,
  options: { body: unknown; signal?: AbortSignal; retryOnUnauthorised?: boolean },
): Promise<Response> {
  const csrf = readCsrfToken();

  const response = await fetch(buildUrl(path, undefined), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf === null ? {} : { [CSRF_HEADER]: csrf }),
    },
    body: JSON.stringify(options.body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (response.status !== 401 || options.retryOnUnauthorised === false) return response;

  // Same one-refresh-at-a-time path every other request uses, so a stream
  // starting at the moment an access token expires does not race a refresh
  // already in flight and rotate the refresh token twice.
  const refreshed = await refreshSession();

  if (!refreshed) {
    announceSessionEnded();
    return response;
  }

  return requestStream(path, { ...options, retryOnUnauthorised: false });
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'GET' }),

  post: <T>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions, 'method' | 'body'>,
  ): Promise<T> =>
    request<T>(path, { ...options, method: 'POST', ...(body === undefined ? {} : { body }) }),

  put: <T>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions, 'method' | 'body'>,
  ): Promise<T> => request<T>(path, { ...options, method: 'PUT', body }),

  patch: <T>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions, 'method' | 'body'>,
  ): Promise<T> =>
    request<T>(path, { ...options, method: 'PATCH', ...(body === undefined ? {} : { body }) }),

  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'DELETE' }),
};

/**
 * A key for an operation that must not be applied twice.
 *
 * Generate it once per attempt and reuse it across retries of that attempt. A
 * new key per retry defeats the point entirely: the server would treat the
 * retry as a new checkout and create a second order.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export { BASE_URL };
