/**
 * Plain-language sourcing (ENH-001): "5,000 boxes of nitrile gloves, CE, FOB,
 * to Germany within 30 days, under 2.50 EUR each" becomes catalogue filters
 * and an RFQ draft. Rules, not a model: what is not recognised stays only in
 * the specification text, and nothing is sent - the buyer edits the draft and
 * presses Send themselves.
 */
const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const;
const CERTS = ['CE', 'FDA', 'ISO 9001', 'ISO 13485', 'ISO 14001', 'GMP', 'RoHS', 'REACH', 'UL', 'BIS', 'EN 455', 'HACCP', 'Halal', 'Kosher'] as const;
const UNITS = ['pieces', 'pcs', 'units', 'boxes', 'cartons', 'pairs', 'kg', 'tonnes', 'tons', 'litres', 'liters', 'metres', 'meters', 'rolls', 'bottles', 'packs', 'sets'] as const;
const CURRENCY_SIGNS: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' };

export interface ParsedSourcing {
  product: string;
  quantity: string | null;
  unit: string | null;
  destinationCountry: string | null;
  incoterm: string | null;
  certifications: string[];
  maxLeadTimeDays: number | null;
  targetPrice: { amount: string; currency: string } | null;
  original: string;
}

function countryCodes(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a += 1) {
      for (let b = 65; b <= 90; b += 1) {
        const code = String.fromCharCode(a, b);
        const name = names.of(code);
        if (name !== undefined && name !== code && !/unknown/i.test(name)) out.set(name.toLowerCase(), code);
      }
    }
  } catch {
    // Without DisplayNames an ISO code after "to" still works.
  }
  return out;
}
let COUNTRIES: Map<string, string> | null = null;

const certPattern = (cert: string): RegExp => new RegExp(`\\b${cert.replace(' ', '\\s*')}\\b`, 'i');

export function parseSourcing(text: string): ParsedSourcing {
  const original = text.trim().slice(0, 2000);
  let rest = ` ${original} `;
  const take = (re: RegExp): RegExpMatchArray | null => {
    const m = rest.match(re);
    if (m !== null) rest = rest.replace(m[0], ' ');
    return m;
  };
  const qty = take(new RegExp(`(\\d[\\d,. ]*\\d|\\d)\\s*(${UNITS.join('|')})\\b`, 'i'));
  const quantity = qty === null ? null : (qty[1] ?? '').replace(/[ ,]/g, '');
  const price = take(/(?:under|below|max(?:imum)?|at|target)\s*([$€£₹])?\s*(\d+(?:\.\d{1,4})?)\s*(?:(?!each\b)([A-Za-z]{3})\b)?\s*(?:each|per\s+\w+|\/\w+)?/i);
  const sign = price?.[1];
  const code = price?.[3] !== undefined && /^[A-Z]{3}$/.test(price[3]) ? price[3] : undefined;
  const currency = price === null ? null : (code ?? (sign !== undefined ? CURRENCY_SIGNS[sign] : undefined) ?? null);
  const lead = take(/within\s+(\d{1,3})\s*days?/i);
  const incoterm = INCOTERMS.find((term) => new RegExp(`\\b${term}\\b`).test(rest)) ?? null;
  if (incoterm !== null) rest = rest.replace(new RegExp(`\\b${incoterm}\\b`), ' ');
  const certifications = CERTS.filter((cert) => certPattern(cert).test(rest));
  for (const cert of certifications) rest = rest.replace(certPattern(cert), ' ');
  COUNTRIES ??= countryCodes();
  let destinationCountry: string | null = null;
  const to = rest.match(/\b(?:to|into|for|in)\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=[,.;]|\s+(?:within|under|by|at|with)\b|\s*$)/i);
  if (to !== null) {
    const words = (to[1] ?? '').trim();
    const code = /^[A-Z]{2}$/.test(words) ? words : (COUNTRIES.get(words.toLowerCase()) ?? null);
    if (code !== null) {
      destinationCountry = code;
      rest = rest.replace(to[0], ' ');
    }
  }
  const product = rest
    .replace(/\b(of|need|we|i|want|looking for|please|buy|source|and)\b/gi, ' ')
    .replace(/[,;.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return {
    product,
    quantity,
    unit: qty === null ? null : (qty[2] ?? '').toLowerCase(),
    destinationCountry,
    incoterm,
    certifications,
    maxLeadTimeDays: lead === null ? null : Number(lead[1]),
    targetPrice: price === null || currency === null ? null : { amount: price[2] ?? '', currency },
    original,
  };
}

/** The catalogue search for it, with the sourcing filters it supports. */
export function searchHref(p: ParsedSourcing): string {
  const q = new URLSearchParams({ q: p.product });
  if (p.certifications.length > 0) q.set('certified', 'true');
  if (p.incoterm !== null) q.set('incoterm', p.incoterm);
  if (p.maxLeadTimeDays !== null) q.set('maxLeadTimeDays', String(p.maxLeadTimeDays));
  return `/search?${q.toString()}`;
}

/** The editable RFQ draft for it; the form reads these and the buyer sends it. */
export function rfqHref(p: ParsedSourcing): string {
  const q = new URLSearchParams({ title: p.product === '' ? p.original.slice(0, 200) : p.product, specification: p.original, from: 'describe' });
  if (p.quantity !== null) q.set('quantity', p.quantity);
  if (p.unit !== null) q.set('unit', p.unit);
  if (p.destinationCountry !== null) q.set('destinationCountry', p.destinationCountry);
  if (p.incoterm !== null) q.set('incoterm', p.incoterm);
  if (p.certifications.length > 0) q.set('certifications', p.certifications.join('\n'));
  if (p.targetPrice !== null) {
    q.set('targetPrice', p.targetPrice.amount);
    q.set('targetCurrency', p.targetPrice.currency);
  }
  return `/account/rfqs/new?${q.toString()}`;
}
