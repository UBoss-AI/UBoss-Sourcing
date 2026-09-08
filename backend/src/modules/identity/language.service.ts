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

/**
 * The language an office in this country works in, or null.
 *
 * This is what makes a sign-in from Berlin land on a German panel without
 * anybody touching the picker. The console asks for it once per sign-in, with
 * the country its own geocoder resolved, and adopts the answer.
 *
 * Three things it deliberately is not:
 *
 *   - **Not a fallback to English.** Null means "leave this person's language
 *     alone", and it is the answer for every country whose language the panel
 *     ships no catalogue for. Somebody in Prague who reads the panel in Polish
 *     keeps Polish; throwing them into English because they are not in Warsaw
 *     would be a worse answer than doing nothing.
 *   - **Not a lock.** The picker still outranks it - see the provider in
 *     apps/admin-web/src/i18n. This chooses a starting point for a sign-in,
 *     once, and a member of staff who wants another language says so and is
 *     believed.
 *   - **Not a hard-coded map.** `countries.languageCode` is a row an operator
 *     edits, because a Brussels office reads French where an Antwerp one reads
 *     Dutch and no table shipped in a release can know which one bought this.
 *
 * A stored code the frontends no longer ship reads back as null, exactly as a
 * withdrawn account preference does: handing the panel a language it has no
 * catalogue for is not an improvement on handing it nothing.
 */
export async function languageForCountry(
  country: string | null,
): Promise<SupportedLanguage | null> {
  if (country === null) return null;

  const row = await prisma.country.findUnique({
    where: { code: country.trim().toUpperCase() },
    select: { languageCode: true },
  });

  const stored = row?.languageCode ?? null;

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
