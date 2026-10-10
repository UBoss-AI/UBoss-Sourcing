/**
 * The agreement boxes on a sign-in form, and what was ticked there - carried
 * to the moment the person is signed in, and nothing more.
 *
 * The boxes are ticked before anybody is signed in, so nothing can be
 * recorded then: there is no account yet, and on the storefront no company.
 * The ids of the exact documents read are held here, in memory only, and the
 * app's first agreement-status request after sign-in records them
 * (`flushSignInAgreements`) against the account - and the company - the
 * SERVER resolves. Never stored in the browser and never proof of anything:
 * when a record fails (a new version, a member who cannot bind the company, a
 * dropped connection) the agreement screen after sign-in asks for what is
 * still missing. The server's gate is the control.
 */
import type { AgreementRole, AgreementScope } from './types';

export interface SignInBox {
  role: AgreementRole;
  /** The kinds read together under this box, in reading order. */
  kinds: readonly string[];
}

/**
 * The boxes each sign-in shows, in the order the server asks for them
 * (`termsKindsForScope` and `servicesKindsForScope` on the server).
 */
export function signInBoxesFor(scope: AgreementScope): readonly SignInBox[] {
  const privacy: SignInBox = { role: 'PRIVACY', kinds: ['PRIVACY_POLICY'] };
  switch (scope) {
    case 'BUYER':
      return [{ role: 'TERMS', kinds: ['PLATFORM_TERMS'] }, privacy];
    case 'CONSUMER':
      return [
        { role: 'TERMS', kinds: ['B2C_CONSUMER_TERMS'] },
        privacy,
        { role: 'SERVICES', kinds: ['B2C_PLATFORM_SERVICES_AGREEMENT'] },
      ];
    case 'COMPANY_BUYER':
      return [
        { role: 'TERMS', kinds: ['B2B_BUYER_TERMS'] },
        privacy,
        { role: 'SERVICES', kinds: ['B2B_BUYER_SERVICES_AGREEMENT'] },
      ];
    case 'SELLER':
      return [
        { role: 'TERMS', kinds: ['PLATFORM_TERMS', 'SELLER_TERMS'] },
        { role: 'SERVICES', kinds: ['SELLER_SERVICES_AGREEMENT'] },
        privacy,
      ];
    case 'LOGISTICS':
      return [{ role: 'TERMS', kinds: ['LOGISTICS_PARTNER_TERMS'] }, privacy];
    case 'STAFF':
      return [{ role: 'TERMS', kinds: ['STAFF_TERMS'] }, privacy];
    case 'AUDIT':
      return [{ role: 'TERMS', kinds: ['AUDIT_CONSOLE_TERMS'] }, privacy];
  }
}

/**
 * The individual sign-in shows the consumer boxes only when every one of the
 * consumer documents is published - the server's rule
 * (`individualAgreementScope`). With any of them missing it shows the
 * buyer boxes, exactly as before.
 */
export function consumerSetComplete(found: readonly (string | null)[]): boolean {
  const kinds = signInBoxesFor('CONSUMER').flatMap((box) => box.kinds);
  return found.length === kinds.length && found.every((id) => id !== null);
}

/** The document ids agreed to under each box; a missing role is not ticked. */
export type SignInAgreementValue = Partial<Record<AgreementRole, string[]>>;

let pending: { scope: AgreementScope; value: SignInAgreementValue } | null = null;
// The recording under way. Several status requests start together right after
// sign-in (development's double effects, a refused call asking again); every
// one of them waits for it, or the ones after the first read the status before
// the boxes are recorded and the screen asks for them a second time.
let recording: Promise<void> | null = null;

/** Hand the ticked boxes to the sign-in that is about to happen; null clears them. */
export function setPendingSignInAgreements(scope: AgreementScope | null, value: SignInAgreementValue = {}): void {
  pending = scope === null ? null : { scope, value };
}

/**
 * Record what was ticked at sign-in, once, before a status request for
 * `askedScope`. The storefront's buyer request also takes a company's boxes:
 * which screen applies is the server's decision, from the session. Each box
 * is its own request; a refusal is left for the agreement screen to explain.
 * A request that arrives while the recording is under way waits for it.
 */
export async function flushSignInAgreements(
  askedScope: AgreementScope,
  record: (role: AgreementRole, documentIds: string[]) => Promise<unknown>,
): Promise<void> {
  const matches =
    pending !== null &&
    (pending.scope === askedScope ||
      (askedScope === 'BUYER' && (pending.scope === 'COMPANY_BUYER' || pending.scope === 'CONSUMER')));
  if (pending !== null && matches) {
    const { value } = pending;
    pending = null;
    const current = (async () => {
      for (const role of ['TERMS', 'PRIVACY', 'SERVICES'] as const) {
        const ids = value[role];
        if (ids === undefined || ids.length === 0) continue;
        try {
          await record(role, ids);
        } catch {
          // Not recorded. The screen after sign-in asks for it again.
        }
      }
    })();
    recording = current;
    void current.finally(() => {
      if (recording === current) recording = null;
    });
  }
  if (recording !== null) await recording;
}
