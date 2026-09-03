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

const CSRF_COOKIE = 'uboss_csrf';
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
  query?: Record<string, string | number | boolean | undefined | null>;
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
  const url = new URL(`${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`);

  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      // Undefined and null mean "no filter", which is not the same as an empty
      // string — `?q=` would filter on the empty string.
      if (value === undefined || value === null || value === '') continue;
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

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'POST', ...(body === undefined ? {} : { body }) }),

  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'PUT', body }),

  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
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
