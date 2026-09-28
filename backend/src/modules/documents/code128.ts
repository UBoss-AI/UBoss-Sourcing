/**
 * Code 128 (subset B), as bar widths a PDF can draw as vector rectangles.
 *
 * Why not a PNG from a library: a bitmap barcode is resampled by every
 * printer driver, and a bar that lands between two dots of a thermal head
 * prints a module wide or narrow and fails to scan. Rectangles drawn in the
 * PDF are rasterised once, by the printer, at its own resolution. And the
 * encoding is a fixed ISO/IEC 15417 table - a hundred lines here are cheaper
 * than a dependency.
 *
 * Subset B covers ASCII 32-127, which is every character a commission invoice
 * number can hold. The barcode carries the invoice number and nothing else:
 * no seller, no buyer, no amount.
 */

/** ISO/IEC 15417 symbol patterns: bar, space, bar, space, bar, space widths in modules. */
const PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232',
];

const START_B = 104;
const STOP = '2331112';

export const CODE128_PATTERNS = PATTERNS;
export const CODE128_STOP = STOP;

export class BarcodeError extends Error {}

/** The symbol values for `text`: start B, one per character, then the check symbol. */
export function code128Values(text: string): number[] {
  if (text.length === 0) throw new BarcodeError('A barcode needs something to encode.');
  const values = [START_B];
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (character.length !== 1 || code < 32 || code > 127) {
      throw new BarcodeError('Code 128 subset B encodes printable ASCII only.');
    }
    values.push(code - 32);
  }
  let checksum = START_B;
  values.slice(1).forEach((value, index) => {
    checksum += value * (index + 1);
  });
  values.push(checksum % 103);
  return values;
}

/**
 * The whole symbol as alternating bar and space widths, in modules, starting
 * with a bar. Quiet zones are the caller's to leave.
 */
export function code128Widths(text: string): number[] {
  const pattern = code128Values(text)
    .map((value) => PATTERNS[value] ?? '')
    .join('')
    .concat(STOP);
  return [...pattern].map(Number);
}

/** Total modules in the symbol, excluding quiet zones. */
export function code128ModuleCount(text: string): number {
  return code128Widths(text).reduce((sum, width) => sum + width, 0);
}
