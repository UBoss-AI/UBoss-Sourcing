/**
 * What in a message draft looks like contact or payment details (JOURNEY-055).
 *
 * Read by `SensitiveDataNotice` to warn louder; nothing is blocked or
 * rewritten. An email address, a long run of digits like a telephone number,
 * a card number that passes the Luhn check, an IBAN.
 */
export type SensitiveDataKind = 'EMAIL' | 'PHONE' | 'CARD' | 'IBAN';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/;

/**
 * Digit runs that may contain spaces, dots or dashes between the digits.
 * References that start with letters - ORD-2026-000123, SKU-1234-5678 - are
 * taken out first: they are what people quote in these threads all day.
 */
function digitRuns(text: string): string[] {
  const withoutReferences = text.replace(/[A-Za-z]+[-/][A-Za-z0-9/-]+/g, ' ');
  return (withoutReferences.match(/\+?\d[\d\s.-]{6,}\d/g) ?? []).map((run) => run.replace(/\D/g, ''));
}

/** Luhn check, so a 16-digit reference is not taken for a card. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** What in this text looks like personal or payment data, in a fixed order. */
export function detectSensitiveData(text: string): SensitiveDataKind[] {
  const found = new Set<SensitiveDataKind>();
  if (EMAIL.test(text)) found.add('EMAIL');
  if (IBAN.test(text.toUpperCase())) found.add('IBAN');
  for (const run of digitRuns(text)) {
    if (run.length >= 13 && run.length <= 19 && passesLuhn(run)) found.add('CARD');
    else if (run.length >= 8 && run.length <= 15) found.add('PHONE');
  }
  return (['EMAIL', 'PHONE', 'CARD', 'IBAN'] as const).filter((kind) => found.has(kind));
}
