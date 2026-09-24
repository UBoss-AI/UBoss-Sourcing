/**
 * Indian GST facts a tax invoice has to get right.
 *
 * Reference data and pure functions only. Nothing here decides a RATE - rates
 * come from the tax class the order was priced under and are frozen on the
 * order line; this file only decides how a rate already charged is PRESENTED:
 * as CGST + SGST inside one state, as IGST across states and on exports.
 *
 * Sources: CGST Rules 2017, Rule 46 (contents of a tax invoice) and the GST
 * state code list published by GSTN (the first two digits of every GSTIN).
 */

/** GST state and union-territory codes, as printed on a GSTIN. */
export const GST_STATE_CODES: Readonly<Record<string, string>> = Object.freeze({
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
});

/** The place-of-supply code GSTN uses for a supply outside India. */
export const OTHER_COUNTRY_CODE = '96';

/** Names people actually type for a state, mapped to the code. */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'jammu & kashmir': '01',
  'j&k': '01',
  'new delhi': '07',
  'nct of delhi': '07',
  'delhi ncr': '07',
  orissa: '21',
  'daman and diu': '26',
  'dadra and nagar haveli': '26',
  pondicherry: '34',
  'andaman & nicobar islands': '35',
  'andaman and nicobar': '35',
  tamilnadu: '33',
  uttaranchal: '05',
});

function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The GST state code for a state name, or null where it is not one. */
export function stateCodeForName(name: string | null | undefined): string | null {
  if (name === null || name === undefined || name.trim() === '') return null;
  const wanted = normalise(name);
  if (/^\d{2}$/.test(wanted) && GST_STATE_CODES[wanted] !== undefined) return wanted;
  for (const [code, stateName] of Object.entries(GST_STATE_CODES)) {
    if (normalise(stateName) === wanted) return code;
  }
  return ALIASES[wanted] ?? null;
}

// ---------------------------------------------------------------------------
// GSTIN
// ---------------------------------------------------------------------------

const GSTIN_SHAPE = /^[0-9]{2}[A-Z0-9]{10}[1-9A-Z]Z[0-9A-Z]$/;
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The fifteenth character of a GSTIN, from the first fourteen.
 *
 * GSTN's published mod-36 algorithm: each character's value is multiplied by
 * 1 or 2 alternately, the product split into quotient and remainder of 36, and
 * both summed; the check character makes the total a multiple of 36.
 */
export function gstinCheckCharacter(first14: string): string {
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    const value = CHARSET.indexOf(first14.charAt(index));
    const product = value * (index % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET.charAt((36 - (sum % 36)) % 36);
}

export type GstinProblem = 'SHAPE' | 'STATE' | 'CHECKSUM';

/** Null for a valid GSTIN, otherwise what is wrong with it. */
export function checkGstin(value: string | null | undefined): GstinProblem | null {
  const gstin = (value ?? '').trim().toUpperCase();
  if (!GSTIN_SHAPE.test(gstin)) return 'SHAPE';
  if (GST_STATE_CODES[gstin.slice(0, 2)] === undefined) return 'STATE';
  if (gstinCheckCharacter(gstin.slice(0, 14)) !== gstin.charAt(14)) return 'CHECKSUM';
  return null;
}

/** HSN: 4, 6 or 8 digits. SAC (services) is out of scope - these are goods. */
export function isValidHsn(value: string | null | undefined): boolean {
  return /^\d{4}(\d{2}){0,2}$/.test((value ?? '').trim());
}

// ---------------------------------------------------------------------------
// Place of supply
// ---------------------------------------------------------------------------

export type GstSupplyType = 'INTRA_STATE' | 'INTER_STATE' | 'EXPORT_WITH_TAX' | 'EXPORT_UNDER_LUT';

export interface PlaceOfSupply {
  supplyType: GstSupplyType;
  stateCode: string;
  stateName: string;
}

/**
 * Where the supply is, for goods that move: the place their movement ends
 * (IGST Act s.10(1)(a)) - the delivery address, not the buyer's billing one.
 *
 * Null when the delivery state cannot be recognised. That is a validation
 * failure the seller is shown, never a guess: the difference between CGST+SGST
 * and IGST is which government is paid.
 */
export function placeOfSupply(input: {
  sellerStateCode: string;
  deliveryCountry: string;
  deliveryState: string | null;
  taxChargedMinor: bigint;
}): PlaceOfSupply | null {
  if (input.deliveryCountry.toUpperCase() !== 'IN') {
    return {
      supplyType: input.taxChargedMinor > 0n ? 'EXPORT_WITH_TAX' : 'EXPORT_UNDER_LUT',
      stateCode: OTHER_COUNTRY_CODE,
      stateName: 'Other Country',
    };
  }

  const code = stateCodeForName(input.deliveryState);
  if (code === null) return null;

  return {
    supplyType: code === input.sellerStateCode ? 'INTRA_STATE' : 'INTER_STATE',
    stateCode: code,
    stateName: GST_STATE_CODES[code] ?? code,
  };
}

/**
 * Split one line's GST into its components.
 *
 * Inside one state it is half central, half state. An odd paisa cannot be
 * halved, so the state half takes it: CGST + SGST always equals exactly the
 * tax charged, which is the figure that must reconcile.
 */
export function splitGst(
  taxMinor: bigint,
  supplyType: GstSupplyType,
): { cgst: bigint; sgst: bigint; igst: bigint } {
  if (supplyType === 'INTRA_STATE') {
    const cgst = taxMinor / 2n;
    return { cgst, sgst: taxMinor - cgst, igst: 0n };
  }
  return { cgst: 0n, sgst: 0n, igst: taxMinor };
}

// ---------------------------------------------------------------------------
// The financial year
// ---------------------------------------------------------------------------

/**
 * The financial year a date falls in, as "2026-27" and its short form
 * "26-27". With an April start, 15 March 2027 is in 2026-27 and 1 April 2027
 * in 2027-28. A calendar-year seller (start month 1) gets "2026".
 */
export function financialYear(day: string, startMonth: number): { label: string; short: string } {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  if (startMonth <= 1) return { label: String(year), short: String(year) };
  const start = month >= startMonth ? year : year - 1;
  const end = (start + 1) % 100;
  return {
    label: `${String(start)}-${String(end).padStart(2, '0')}`,
    short: `${String(start % 100).padStart(2, '0')}-${String(end).padStart(2, '0')}`,
  };
}

// ---------------------------------------------------------------------------
// Amount in words
// ---------------------------------------------------------------------------

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const tens = TENS[Math.floor(n / 10)] ?? '';
  const ones = n % 10;
  return ones === 0 ? tens : `${tens} ${ONES[ones] ?? ''}`;
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds] ?? ''} Hundred`);
  if (rest > 0) parts.push(belowHundred(rest));
  return parts.join(' ');
}

/** Whole units in words, in the Indian system (lakh, crore). */
function indianWords(value: bigint): string {
  if (value === 0n) return 'Zero';
  const parts: string[] = [];
  let remaining = value;
  const crore = remaining / 10_000_000n;
  remaining %= 10_000_000n;
  if (crore > 0n) parts.push(`${indianWords(crore)} Crore`);
  const lakh = Number(remaining / 100_000n);
  remaining %= 100_000n;
  if (lakh > 0) parts.push(`${belowHundred(lakh)} Lakh`);
  const thousand = Number(remaining / 1000n);
  remaining %= 1000n;
  if (thousand > 0) parts.push(`${belowHundred(thousand)} Thousand`);
  if (remaining > 0n) parts.push(belowThousand(Number(remaining)));
  return parts.join(' ');
}

/** Whole units in words, in the international system (thousand, million). */
function internationalWords(value: bigint): string {
  if (value === 0n) return 'Zero';
  const scales = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];
  const parts: string[] = [];
  let remaining = value;
  let scale = 0;
  while (remaining > 0n && scale < scales.length) {
    const chunk = Number(remaining % 1000n);
    if (chunk > 0)
      parts.unshift(
        `${belowThousand(chunk)}${scales[scale] === '' ? '' : ` ${scales[scale] ?? ''}`}`,
      );
    remaining /= 1000n;
    scale += 1;
  }
  return parts.join(' ');
}

const CURRENCY_WORDS: Readonly<Record<string, [string, string]>> = Object.freeze({
  INR: ['Rupees', 'Paise'],
  EUR: ['Euro', 'Cents'],
  USD: ['US Dollars', 'Cents'],
  GBP: ['Pounds Sterling', 'Pence'],
  AED: ['Dirhams', 'Fils'],
  SGD: ['Singapore Dollars', 'Cents'],
  PLN: ['Zloty', 'Groszy'],
});

/**
 * "Rupees Nine Lakh Sixty Thousand and Fifty Paise Only".
 *
 * English, as the invoice's legal language; the Indian system for rupees and
 * the international one for everything else. A two-decimal currency is
 * assumed - the only ones this deployment prices in.
 */
export function amountInWords(minor: bigint, currency: string): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / 100n;
  const fraction = Number(absolute % 100n);
  const [major, minorName] = CURRENCY_WORDS[currency.toUpperCase()] ?? [
    currency.toUpperCase(),
    'Hundredths',
  ];
  const words = currency.toUpperCase() === 'INR' ? indianWords(whole) : internationalWords(whole);
  const cents = fraction === 0 ? '' : ` and ${belowHundred(fraction)} ${minorName}`;
  return `${negative ? 'Minus ' : ''}${major} ${words}${cents} Only`;
}
