/**
 * Where a placeholder price comes from.
 *
 * Separated from the command that applies it so it can be read and tested
 * without running anything: importing a `.cli.ts` executes it.
 */
import { parseMajorToMinor, type Minor } from '../../../domain/money.js';

/**
 * A cell of a supplier sheet as an amount, or null.
 *
 * Null for every way a spreadsheet says "no price": an empty cell, "N/A", a
 * dash, a zero somebody typed into a column they had nothing for, and anything
 * with a currency symbol or a thousands separator in it. Those are not prices
 * and guessing at them is how a catalogue ends up selling at 1,299 rupees
 * because the cell said "1,299.00" and something read the "1".
 *
 * The parsing itself is `domain/money.ts`'s, not a local copy: it is
 * currency-aware - a yen amount has no minor units at all - and it is the one
 * place in this project allowed to turn a typed decimal into money.
 */
export function priceFromCell(value: unknown, currency: string): Minor | null {
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (text === '') return null;

  let minor: Minor;
  try {
    minor = parseMajorToMinor(text, currency);
  } catch {
    // MoneyError: the cell is "N/A", "-", prose, or punctuated. Not a price.
    return null;
  }

  // Zero and negative are refused rather than carried. A zero in a price
  // column is an empty cell somebody filled in, and it would put the product
  // back where it started - unsellable, or worse, free.
  return minor > 0n ? minor : null;
}

/**
 * The supplier sheet's own figure for a product, out of the row the import
 * kept verbatim.
 *
 * Column M is the MRP. The IMPORTER still does not read it, and the note in
 * `sheet-mapping.ts` saying so is still true: an MRP is a consumer retail
 * price from another market under another regulation, and importing it AS the
 * selling price - silently, as part of loading a catalogue - would put a
 * figure in front of a buyer that nobody in the business agreed to charge.
 *
 * Reading it here is a different act. A person runs `catalog:prices` on
 * purpose, knowing the result is a placeholder, and every row it touches is
 * flagged as one. It is used because the operator's own number is a better
 * placeholder than one invented in this file.
 */
export function mrpFromSourceRow(rawJson: unknown, currency: string): Minor | null {
  if (typeof rawJson !== 'object' || rawJson === null) return null;
  return priceFromCell((rawJson as Record<string, unknown>).M, currency);
}
