/**
 * How a thrown value becomes one of the ten kinds — and the two values from an
 * error that are allowed anywhere near the screen.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '@/lib/api';
import {
  classifyError,
  isChunkLoadError,
  kindForStatus,
  safeInternalPath,
  safeReference,
} from './error-kind';

function apiError(status: number, correlationId?: string): ApiError {
  return new ApiError(status, {
    code: 'SOMETHING',
    message: 'SELECT * FROM users WHERE token = abc — internal detail',
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

describe('kindForStatus', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'notFound'],
    [410, 'notFound'],
    [408, 'timeout'],
    [504, 'timeout'],
    [429, 'rateLimited'],
    [500, 'server'],
    [502, 'badGateway'],
    [503, 'unavailable'],
    [409, 'server'],
  ])('%i is %s', (status, kind) => {
    expect(kindForStatus(status)).toBe(kind);
  });
});

describe('classifyError', () => {
  it('reads an ApiError by its status, and keeps its correlation id', () => {
    expect(classifyError(apiError(503, '01J9ZK4M7Q2R8T5V3W6X9Y0ABC'))).toEqual({
      kind: 'unavailable',
      statusCode: 503,
      reference: '01J9ZK4M7Q2R8T5V3W6X9Y0ABC',
    });
  });

  it('reads a router error response by its status', () => {
    const response = { status: 404, statusText: 'Not Found', internal: false, data: null };
    // The shape `isRouteErrorResponse` checks for.
    expect(classifyError(response).kind).toBe('notFound');
  });

  it('calls a failed chunk a new version when online, and offline when not', () => {
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/Cart-abc.js');
    expect(classifyError(error, true).kind).toBe('chunk');
    expect(classifyError(error, false).kind).toBe('offline');
  });

  it('calls a rejected fetch a connection problem, with no numeral it did not get', () => {
    expect(classifyError(new TypeError('Failed to fetch'), true)).toEqual({
      kind: 'badGateway',
      statusCode: null,
      reference: null,
    });
  });

  it('reads the API client network failure as a connection problem', () => {
    // Constructed loosely: the storefront's takes an `isOffline` flag and the
    // panels' does not, and this file runs in all three apps.
    const error = new (NetworkError as unknown as new (message: string) => Error)('Network request failed');
    expect(classifyError(error, true).kind).toBe('badGateway');
    expect(classifyError(error, false).kind).toBe('offline');
  });

  it('calls a crash in the page itself "something went wrong", without claiming a 500', () => {
    expect(classifyError(new Error('Cannot read properties of undefined'), true)).toEqual({
      kind: 'server',
      statusCode: null,
      reference: null,
    });
  });

  it('treats a thrown non-Error as a crash', () => {
    expect(classifyError('boom', true).kind).toBe('server');
    expect(classifyError(undefined, true).kind).toBe('server');
  });

  it('never carries the error message anywhere in its result', () => {
    const result = JSON.stringify(classifyError(apiError(500, '01J9ZK4M7Q2R8T5V3W6X9Y0ABC')));
    expect(result).not.toContain('SELECT');
    expect(result).not.toContain('token');
  });
});

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/assets/a.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Loading chunk 42 failed.',
    'Loading CSS chunk vendors failed',
    'Unable to preload CSS for /assets/a.css',
  ])('recognises "%s"', (message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true);
  });

  it('does not mistake an ordinary error for one', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of null'))).toBe(false);
    expect(isChunkLoadError('Loading chunk 1 failed')).toBe(false);
  });
});

describe('safeReference', () => {
  it('keeps an id that looks like one', () => {
    expect(safeReference('01J9ZK4M7Q2R8T5V3W6X9Y0ABC')).toBe('01J9ZK4M7Q2R8T5V3W6X9Y0ABC');
    expect(safeReference('3f2b9c1e-7d4a-4f0b-9a55-2c1d8e6b7a90')).toBe(
      '3f2b9c1e-7d4a-4f0b-9a55-2c1d8e6b7a90',
    );
  });

  it('drops anything that could be something else', () => {
    expect(safeReference('<script>alert(1)</script>')).toBeNull();
    expect(safeReference('user@example.com')).toBeNull();
    expect(safeReference('a b')).toBeNull();
    expect(safeReference('x'.repeat(65))).toBeNull();
    expect(safeReference(42)).toBeNull();
    expect(safeReference(null)).toBeNull();
  });
});

describe('safeInternalPath', () => {
  it('keeps a path on this site', () => {
    expect(safeInternalPath('/account/orders?page=2')).toBe('/account/orders?page=2');
  });

  it('refuses anything that leaves it', () => {
    expect(safeInternalPath('//evil.example')).toBeNull();
    expect(safeInternalPath('/\\evil.example')).toBeNull();
    expect(safeInternalPath('https://evil.example')).toBeNull();
    expect(safeInternalPath('javascript:alert(1)')).toBeNull();
    expect(safeInternalPath('account')).toBeNull();
  });
});
