/**
 * What went wrong, in the terms a full-page error can say out loud.
 *
 * Every full-page error in the three apps is one of these ten kinds. The kind
 * decides the heading, the message and which ways onward are offered; the
 * status code, when there is one, is only the numeral drawn above them.
 *
 * **Nothing from the error itself reaches the screen.** Not `error.message`,
 * not a stack, not the server's own wording: a message written for a log can
 * carry a table name, a file path or an address, and the page cannot tell
 * which. What the visitor reads comes from the translation catalogue, chosen
 * by kind. The one value that does come through is the server's correlation
 * id, and only when it looks like one (`safeReference`), because support staff
 * need it to find the matching log line.
 *
 * This folder is the same files in all three apps. `error-page-sync.test.ts`
 * in the admin and logistics apps fails the build when a copy drifts, so edit
 * the storefront's and copy it across.
 */
import { isRouteErrorResponse } from 'react-router-dom';
import { ApiError, NetworkError } from '@/lib/api';

export type ErrorKind =
  | 'notFound'
  | 'unauthorized'
  | 'forbidden'
  | 'timeout'
  | 'rateLimited'
  | 'server'
  | 'badGateway'
  | 'unavailable'
  | 'offline'
  | 'chunk';

/**
 * The numeral each kind draws when nobody passed a real status code.
 *
 * `null` for the two that are not HTTP answers at all: an offline browser and
 * a script file that failed to load never got a status to show.
 */
export const DEFAULT_STATUS: Readonly<Record<ErrorKind, number | null>> = {
  notFound: 404,
  unauthorized: 401,
  forbidden: 403,
  timeout: 408,
  rateLimited: 429,
  server: 500,
  badGateway: 502,
  unavailable: 503,
  offline: null,
  chunk: null,
};

/**
 * The kinds where pressing "Try again" cannot do harm.
 *
 * Retrying on this page means reloading it, which repeats a GET and nothing
 * else — never the order, payment or submission that may have led here. The
 * three that are not listed would come back with the same answer.
 */
export const RETRYABLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'timeout',
  'rateLimited',
  'server',
  'badGateway',
  'unavailable',
  'offline',
]);

export function kindForStatus(status: number): ErrorKind {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
    case 410:
      return 'notFound';
    case 408:
    case 504:
      return 'timeout';
    case 429:
      return 'rateLimited';
    case 502:
      return 'badGateway';
    case 503:
      return 'unavailable';
    default:
      return 'server';
  }
}

/**
 * The messages browsers use when a lazily-loaded chunk cannot be fetched.
 *
 * Chrome, Firefox and Safari each word it differently, and none gives the
 * error a distinct type. The usual cause is a deployment: the page in the tab
 * still names the previous build's file hashes, and those files are gone.
 */
const CHUNK_FAILURE: readonly RegExp[] = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Loading (CSS )?chunk [\w-]+ failed/i,
  /Unable to preload CSS/i,
];

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ChunkLoadError') return true;
  return CHUNK_FAILURE.some((pattern) => pattern.test(error.message));
}

/**
 * A correlation id, or nothing.
 *
 * The backend issues short opaque ids. Anything longer, or containing a
 * character an id never has, is not shown: this is the one value from an
 * error that reaches the screen, so it is held to the shape it should have.
 */
export function safeReference(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[A-Za-z0-9._:-]{4,64}$/.test(value) ? value : null;
}

/**
 * A path on this site, or `null`.
 *
 * One leading slash, and the next character must not be another slash or a
 * backslash: `//evil.example` is a protocol-relative URL, and `/\evil.example`
 * becomes one once a browser normalises the backslash. The same rule the
 * storefront's sign-in page applies to where it sends people afterwards.
 */
export function safeInternalPath(value: string): string | null {
  return /^\/(?![/\\])/.test(value) ? value : null;
}

export interface ClassifiedError {
  kind: ErrorKind;
  /** `undefined` draws the kind's usual numeral; `null` draws none. */
  statusCode: number | null | undefined;
  reference: string | null;
}

function browserIsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

/**
 * Sort an unknown thrown value into a kind.
 *
 * Offline wins over everything that could be a symptom of it: a chunk that
 * failed to load and a fetch that rejected are both what being offline looks
 * like, and "check your connection" is the advice that fixes them.
 */
export function classifyError(error: unknown, online: boolean = browserIsOnline()): ClassifiedError {
  if (error instanceof ApiError) {
    return {
      kind: kindForStatus(error.status),
      statusCode: error.status,
      reference: safeReference(error.correlationId),
    };
  }

  if (isRouteErrorResponse(error)) {
    return { kind: kindForStatus(error.status), statusCode: error.status, reference: null };
  }

  if (!online) return { kind: 'offline', statusCode: null, reference: null };

  // The API client's own name for a request that never got an answer. The
  // storefront's copy also records whether the browser was offline when it
  // failed, which outranks what `navigator.onLine` says a moment later.
  if (error instanceof NetworkError) {
    // Read as unknown: the field is a boolean in the storefront's class and
    // absent from the panels', and this file is the same in all three.
    const wasOffline = (error as { isOffline?: unknown }).isOffline === true;
    return { kind: wasOffline ? 'offline' : 'badGateway', statusCode: null, reference: null };
  }

  if (isChunkLoadError(error)) return { kind: 'chunk', statusCode: null, reference: null };

  // fetch rejects with a TypeError when the request never got an answer: the
  // server is down, or something between here and it refused the connection.
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return { kind: 'badGateway', statusCode: null, reference: null };
  }

  // A crash in this page's own code. There was no server answer, so no
  // numeral: drawing "500" would claim the server failed when it did not.
  return { kind: 'server', statusCode: null, reference: null };
}
