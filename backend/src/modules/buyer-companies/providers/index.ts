/**
 * Every verification provider, in the order the console lists their results.
 *
 * Automated registries first, then the checks a reviewer has to make by hand.
 * The rules-based signals (identifier consistency, email domain, duplicates)
 * are not providers: they read our own data rather than a register, and live
 * in `checks.service.ts`.
 */
import { MANUAL_PROVIDERS } from './manual.js';
import { gleifProvider, plKrsProvider, plVatRegisterProvider, viesProvider } from './registries.js';
import type { BusinessVerificationProvider } from './types.js';

export const VERIFICATION_PROVIDERS: readonly BusinessVerificationProvider[] = Object.freeze([
  viesProvider,
  plVatRegisterProvider,
  plKrsProvider,
  gleifProvider,
  ...MANUAL_PROVIDERS,
]);

export type { BusinessVerificationProvider, CheckResult, CompanySubject } from './types.js';
