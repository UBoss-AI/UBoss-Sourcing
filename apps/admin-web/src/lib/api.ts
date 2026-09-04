/**
 * The API client.
 *
 * Every request in the admin panel goes through here, so the rules the backend
 * enforces are honoured in exactly one place:
 *
 *   - **Cookies, not tokens.** Access and refresh tokens are httpOnly; this
 *     code cannot read them and must not try. `credentials: 'include'` is
 *     mandatory on every call, including the cross-origin ones in development.
 *   - **Double-submit CSRF.** The `uboss_csrf` cookie is the one cookie
 *     readable by JavaScript. Its value is copied into `x-csrf-token` on every
 *     unsafe method. Forget it and every write returns FORBIDDEN.
 *   - **One refresh at a time.** A 401 triggers a single refresh, and every
 *     request that hit 401 in the meantime waits on that same promise. Firing
 *     one refresh per in-flight request rotates the refresh token repeatedly
 *     and the backend's reuse detection kills the session.
 *   - **The error envelope is the contract.** `{ error: { code, message,
 *     details, correlationId } }`, always. `ApiError` carries all four so a
 *     form can map `details` onto fields and a support request can quote the
 *     correlation id.
 */

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1').replace(
  /\/+$/,
  '',
);

// Scoped to this surface. A cookie is identified by name, domain and path -
// not by port - so the admin panel and the storefront share one jar whenever
// they sit on the same hostname. Shared names meant signing into one
// silently signed you out of the other.
const CSRF_COOKIE = 'uboss_admin_csrf';
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

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details ?? [];
    this.correlationId = body.correlationId ?? null;
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

  get isPermissionError(): boolean {
    return this.status === 403 && this.code !== 'FORBIDDEN';
  }
}

/** A transport failure - no response at all. Distinct from a 4xx or 5xx. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
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
 * The auth provider subscribes and clears its user, so a dead session shows a
 * login screen rather than a page full of failed panels.
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
      const response = await fetch(`${BASE_URL}/admin/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: csrf === null ? {} : { [CSRF_HEADER]: csrf },
      });
      return response.ok;
    } catch {
      // A refresh that could not reach the server is not a dead session; the
      // caller reports the network failure instead of logging the user out.
      return false;
    } finally {
      // Cleared in a microtask so callers awaiting this promise all observe
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
  /** Multipart upload. Set instead of `body`; no Content-Type is added. */
  formData?: FormData;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Sent as `Idempotency-Key`. Required by the backend on payment writes. */
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
      // string - sending `?q=` would filter on the empty string.
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

function toApiError(status: number, body: unknown): ApiError {
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body).error === 'object'
  ) {
    return new ApiError(status, (body as { error: ApiErrorBody }).error);
  }

  // A response that is not the envelope means something upstream of the app
  // answered - a proxy, a gateway. Say that rather than inventing a code.
  return new ApiError(status, {
    code: 'UNEXPECTED_RESPONSE',
    message:
      typeof body === 'string' && body.length > 0 && body.length < 300
        ? body
        : `The server returned an unexpected ${String(status)} response.`,
  });
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

  if (options.formData !== undefined) {
    // Setting Content-Type by hand omits the multipart boundary and the server
    // cannot parse the body. The browser must set this header itself.
    body = options.formData;
  } else if (options.body !== undefined) {
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
    throw new NetworkError('Could not reach the server. Check your connection and try again.');
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

  throw toApiError(response.status, payload);
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'POST', ...(body === undefined ? {} : { body }) }),

  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'PATCH', ...(body === undefined ? {} : { body }) }),

  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'PUT', ...(body === undefined ? {} : { body }) }),

  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'DELETE' }),

  upload: <T>(path: string, formData: FormData, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
    request<T>(path, { ...options, method: 'POST', formData }),
};

/**
 * A file download that needs the session cookie.
 *
 * A plain `<a href>` would work for a same-origin deployment but not in
 * development, where the API is on another port and the browser sends no
 * credentials. Fetching and revoking an object URL works in both.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(buildUrl(path, undefined), { credentials: 'include' });

  if (!response.ok) {
    throw toApiError(response.status, await parseBody(response));
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = match?.[1] ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
}

export { BASE_URL };
