/** Dates and language names, in the reader's own language. */

export function formatAgreementDate(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'long' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** A language's name in the reader's language, for saying which language a text is in. */
export function languageName(code: string, inLanguage: string): string {
  try {
    return new Intl.DisplayNames([inLanguage], { type: 'language' }).of(code) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}
