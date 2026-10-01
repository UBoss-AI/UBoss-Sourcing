/**
 * Controlled cross-border access to the most sensitive files (SEC-007).
 *
 * Identity documents, KYB files, bank proofs and privacy requests may, by the
 * operator's policy, only be opened by staff working from named countries.
 * The country comes from a header a trusted reverse proxy sets
 * (`STAFF_COUNTRY_HEADER`); the browser cannot choose it, because the proxy
 * overwrites it. With no list configured nothing changes, so a deployment
 * that has not made that decision is not locked out of its own data.
 *
 * Fails closed: with a list set, a request without the header is refused,
 * since "we do not know where this is" is not one of the allowed countries.
 */
import type { FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { AppError, ErrorCode } from '../../domain/errors.js';

export function assertStaffDataRegion(request: FastifyRequest): void {
  const allowed = env.STAFF_SENSITIVE_DATA_COUNTRIES.map((code) => code.toUpperCase());
  if (allowed.length === 0) return;
  const raw = request.headers[env.STAFF_COUNTRY_HEADER];
  const country = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase() ?? '';
  if (!allowed.includes(country)) {
    throw new AppError({
      statusCode: 403,
      code: ErrorCode.PERMISSION_DENIED,
      message: 'This file can only be opened from a country your organisation allows.',
      details: [{ field: 'country', code: 'DATA_REGION_NOT_ALLOWED' }],
    });
  }
}
