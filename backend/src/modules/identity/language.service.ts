/**
 * The interface language, per account.
 *
 * One service for both surfaces. A staff user and a customer store this in the
 * same place - `users.preferredLanguage` - because the thing being remembered
 * is the same thing, and splitting it across two tables would mean a member of
 * staff who also holds a customer login has to set it twice.
 *
 * The list below is the backend's own copy of what the frontends support, and
 * it has to stay in step with the `languages.ts` registry in each of
 * `apps/admin-web` and `apps/customer-web`. It is duplicated rather than
 * shared because the two apps are built independently of the API, with no
 * package between them to hold it.
 *
 * The validation it drives is not cosmetic. This value is written into
 * `<html lang>` and, in time, chooses which template a transactional email is
 * rendered from; accepting whatever string a client sent would make it a place
 * to store arbitrary text against an account.
 */
import { prisma } from '../../infra/prisma.js';

/**
 * Languages the interface exists in. Keep in step with the frontend registry.
 *
 * A code here that has no catalogue in the frontends is harmless - it falls
 * back to English. The reverse is not: a catalogue the API rejects can be
 * chosen in the picker and then refuses to save.
 */
export const SUPPORTED_LANGUAGES = ['en', 'nl', 'fr', 'de', 'el', 'it', 'pl', 'es'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * What this account has chosen, or null if it never has.
 *
 * Null is a real answer, not a missing one: it tells the caller to fall back to
 * the browser's preference rather than to assume English.
 *
 * A value that is no longer supported - a language withdrawn after somebody
 * chose it - reads back as null for the same reason. The alternative is
 * handing the frontend a code it has no catalogue for and letting it work that
 * out downstream.
 */
export async function getUserLanguage(userId: string): Promise<SupportedLanguage | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferredLanguage: true },
  });

  const stored = user?.preferredLanguage ?? null;

  return isSupportedLanguage(stored) ? stored : null;
}

/** Save a choice. The caller is responsible for having validated it. */
export async function setUserLanguage(
  userId: string,
  language: SupportedLanguage,
): Promise<SupportedLanguage> {
  await prisma.user.update({
    where: { id: userId },
    data: { preferredLanguage: language },
  });

  return language;
}
