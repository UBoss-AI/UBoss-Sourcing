/**
 * The four separate things an applicant agrees to when submitting.
 *
 * Four, never one checkbox for all of them: agreeing to terms, declaring the
 * information accurate, having read the privacy notice and claiming authority
 * to act for the company are different acts with different consequences, and
 * a single pre-ticked box would make none of them mean anything.
 *
 * The English text below is the canonical wording for its version. The
 * storefront shows the same meaning in the reader's language; the record
 * stores this version's number and the SHA-256 of this English text, so a
 * later dispute can establish exactly which words were agreed to.
 *
 * THE PRIVACY LINE IS AN ACKNOWLEDGEMENT, NOT A CONSENT. The processing rests
 * on the contract the buyer is asking to enter (Art. 6(1)(b)) and on the
 * marketplace's legitimate interest in not selling on account to a company
 * that does not exist (Art. 6(1)(f)). Wording it as "I consent" would imply
 * the application could proceed without it, which it cannot. This framing is
 * a product decision that a deployment's own counsel should confirm.
 */
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';

export type ConsentPurposeName =
  'ACCURACY_DECLARATION' | 'BUSINESS_TERMS' | 'PRIVACY_NOTICE' | 'AUTHORITY_TO_ACT';

export const CONSENT_PURPOSES: readonly ConsentPurposeName[] = Object.freeze([
  'ACCURACY_DECLARATION',
  'BUSINESS_TERMS',
  'PRIVACY_NOTICE',
  'AUTHORITY_TO_ACT',
]);

const TEXT: Record<ConsentPurposeName, string> = {
  ACCURACY_DECLARATION:
    'I confirm that the information in this application is accurate and complete, and I will tell you if it changes.',
  BUSINESS_TERMS: 'I accept the terms of sale for business accounts on behalf of the company.',
  PRIVACY_NOTICE:
    'I have read the privacy notice, which explains how the information in this application is used to verify the company and how long it is kept.',
  AUTHORITY_TO_ACT: 'I am authorised to register this company and to act on its behalf.',
};

export function consentText(purpose: ConsentPurposeName): string {
  return TEXT[purpose];
}

export function consentVersion(): string {
  return env.BUYER_COMPANY_CONSENT_VERSION;
}

export function consentTextHash(purpose: ConsentPurposeName): string {
  return createHash('sha256').update(`${consentVersion()}\n${TEXT[purpose]}`).digest('hex');
}
