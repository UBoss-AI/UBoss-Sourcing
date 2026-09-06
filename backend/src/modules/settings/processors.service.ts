/**
 * Who else sees the data, derived from what is actually configured.
 *
 * GDPR Art. 30(1)(d) asks a controller to record the categories of recipient
 * their data goes to, and Arts. 13(1)(e) and 44-49 oblige them to say so in
 * their privacy notice and to have a transfer mechanism for anyone outside the
 * EEA. Both obligations are usually met by a list somebody typed into a
 * document eighteen months ago.
 *
 * The trouble with that list is that it is a claim about configuration, kept
 * somewhere that configuration cannot reach. Somebody sets `GEMINI_API_KEY` to
 * try the chat widget, the deployment starts sending visitors' questions to
 * Google, and the register still says the only processor is the payment
 * gateway. Nothing warns anybody, because nothing is watching.
 *
 * So this reads the environment instead. Every entry below is switched on by a
 * setting, says which one, and reports itself as active only when that setting
 * actually has a value. An operator can put the output beside their register
 * and see the difference — which is the whole point, and is why it deliberately
 * reports the inactive ones too.
 *
 * Two limits, stated rather than hidden. It knows only about integrations this
 * codebase makes itself: a reverse proxy that logs, a managed database, a
 * backup target and an error tracker are all recipients this cannot see. And
 * "where" is where the company is established, which is not always where the
 * data is processed — an EEA region on a US provider is still a US company's
 * infrastructure, and whether that matters is a question for a lawyer, not a
 * boolean.
 */
import { env } from '../../config/env.js';
import { activeProvider } from '../assistant/assistant.service.js';

export interface ProcessorEntry {
  /** Stable key, so the admin panel can translate the description. */
  key: string;
  name: string;
  /** What it does for this deployment, in one line. */
  purpose: string;
  /** What actually leaves the building. */
  dataShared: string;
  /**
   * ISO-3166 alpha-2 of where the recipient is established, 'SELF_HOSTED' for
   * something the operator runs, or 'UNKNOWN' where the setting is a URL the
   * deployment chose and this cannot tell.
   */
  location: string;
  /**
   * Whether anything about a person actually goes to this recipient.
   *
   * The exchange-rate feed is on the list and carries nothing but currency
   * codes. Counting it as an international transfer would put a harmless entry
   * on the Art. 44 list and teach whoever reads it to skim.
   */
  carriesPersonalData: boolean;
  /**
   * Derived from `location`, never asserted per entry.
   *
   * Two fields that have to agree are two fields that eventually will not:
   * somebody corrects a country and leaves the flag, and the register quietly
   * stops matching reality.
   */
  outsideEea: boolean;
  /** The setting that switches it on. */
  configuredBy: string;
  active: boolean;
  /** Present when a recipient is active and needs a decision from the operator. */
  note?: string;
}

/**
 * The EEA, for the transfer question.
 *
 * The three EFTA states are in it and the twenty-seven member states are
 * obviously in it, but this list only has to classify the handful of countries
 * the entries below can actually name, so it is written out rather than read
 * from `countries` — a processor's country is not a market this shop sells to
 * and has no business depending on the storefront's country table.
 */
const EEA = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR',
  'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT',
  'RO', 'SE', 'SI', 'SK',
]);

/**
 * Whether a recipient sits outside the EEA.
 *
 * 'UNKNOWN' counts as outside on purpose. A URL the deployment pointed
 * somewhere this code cannot resolve is exactly the case that needs a human to
 * look, and answering "probably fine" would be the software making that call
 * on their behalf.
 */
function outside(location: string): boolean {
  return location !== 'SELF_HOSTED' && !EEA.has(location);
}

/** An entry as written below, before `outsideEea` is worked out. */
type ProcessorDraft = Omit<ProcessorEntry, 'outsideEea'>;

/**
 * Which host a configured URL actually points at.
 *
 * The geocoder and the rate feed are URLs rather than fixed vendors precisely
 * so a deployment can point them at its own infrastructure, and a register
 * that named OpenStreetMap for an installation calling its own geocoder would
 * be wrong in the direction that matters.
 */
function hostOf(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  try {
    return new URL(trimmed.replace(/\{[a-z]+\}/gi, 'x')).host;
  } catch {
    return null;
  }
}

export interface ProcessorReport {
  generatedAt: string;
  entries: ProcessorEntry[];
  /** Active recipients established outside the EEA. The Art. 44-49 list. */
  transfersOutsideEea: number;
}

export function processorReport(): ProcessorReport {
  const drafts: ProcessorDraft[] = [];

  // --- Payments ---------------------------------------------------------
  drafts.push({
    key: 'stripe',
    name: 'Stripe',
    purpose: 'Card payments and payment links.',
    dataShared: 'Order reference, amount, currency, and the payer’s email where a link is sent.',
    location: 'IE',
    carriesPersonalData: true,
    configuredBy: 'STRIPE_SECRET_KEY',
    active: env.STRIPE_SECRET_KEY.trim().length > 0,
    note:
      'Stripe Payments Europe is Irish, but the group is US-owned and routes through Stripe, ' +
      'Inc. Their DPA and SCCs cover it; keep a copy with your Art. 30 register.',
  });

  drafts.push({
    key: 'razorpay',
    name: 'Razorpay',
    purpose: 'Card and UPI payments.',
    dataShared: 'Order reference, amount, currency, and the payer’s contact details.',
    location: 'IN',
    carriesPersonalData: true,
    configuredBy: 'RAZORPAY_KEY_ID',
    active: env.RAZORPAY_KEY_ID.trim().length > 0,
    note:
      'India has no EU adequacy decision, so a transfer here needs SCCs and a transfer impact ' +
      'assessment. Razorpay is also not an EEA acquirer — for EU trade, use Stripe.',
  });

  // --- The assistant ----------------------------------------------------
  const provider = activeProvider();

  drafts.push({
    key: 'ai-provider',
    name: provider === null ? 'AI provider (none configured)' : providerVendor(provider.name),
    purpose: 'Answers storefront chat questions from the published catalogue.',
    dataShared:
      'Whatever the visitor types, plus the published catalogue. Account, order and payment ' +
      'data are never sent — see the system prompt in assistant.service.ts.',
    location: provider === null ? 'SELF_HOSTED' : 'US',
    carriesPersonalData: true,
    configuredBy: 'ANTHROPIC_API_KEY / GEMINI_API_KEY',
    active: provider !== null,
    note:
      'A free-text box is a free-text box: visitors put personal data in one whatever the ' +
      'label says. Name this provider in your privacy notice, and unset the key to switch ' +
      'the widget off entirely.',
  });

  // --- Email ------------------------------------------------------------
  drafts.push({
    key: 'smtp',
    name: env.SMTP_HOST.trim().length > 0 ? env.SMTP_HOST : 'SMTP relay (none configured)',
    purpose: 'Delivers order confirmations, invitations and password resets.',
    dataShared: 'Recipient address and the full rendered message.',
    // Unknowable from here: it is whichever host the operator pointed at.
    location: 'SELF_HOSTED',
    carriesPersonalData: true,
    configuredBy: 'SMTP_HOST',
    active: env.EMAIL_DRIVER === 'smtp' && env.SMTP_HOST.trim().length > 0,
    note:
      'Where this one sits is a question only you can answer. If it is a hosted relay outside ' +
      'the EEA, add it to your register and cover it with an Art. 28 contract.',
  });

  // --- Geocoding --------------------------------------------------------
  const geocoder = hostOf(env.GEOCODE_REVERSE_URL);

  drafts.push({
    key: 'geocoder',
    name: geocoder ?? 'Reverse geocoder (switched off)',
    purpose: 'Turns an admin sign-in’s coordinates into a place name.',
    dataShared: 'The coordinates of a member of staff’s device at sign-in.',
    location: geocoder === null ? 'SELF_HOSTED' : 'UNKNOWN',
    carriesPersonalData: true,
    configuredBy: 'GEOCODE_REVERSE_URL',
    active: env.FEATURE_ADMIN_LOGIN_LOCATION && geocoder !== null,
    note:
      'This one shares STAFF location data, which is employee monitoring. See ' +
      'docs/DATA-PROTECTION.md §2.1 before leaving it on in the EU — it is the single setting ' +
      'most likely to be a problem there.',
  });

  // --- Exchange rates ---------------------------------------------------
  const fx = hostOf(env.FX_RATE_URL);

  drafts.push({
    key: 'fx-rates',
    name: fx ?? 'Exchange rate feed',
    purpose: 'Refreshes converted catalogue prices.',
    // Worth stating plainly: this one is on the list for completeness, and an
    // operator who sees it there should not have to work out that it is
    // harmless.
    dataShared: 'Nothing. Currency codes only — no personal data leaves in either direction.',
    location: fx === null ? 'SELF_HOSTED' : 'UNKNOWN',
    // The one entry on this list that is genuinely harmless. Said explicitly,
    // so an operator does not have to work it out from the purpose line.
    carriesPersonalData: false,
    configuredBy: 'FX_RATE_URL',
    active: fx !== null,
  });

  // --- VAT number checking ----------------------------------------------
  const vies = hostOf(env.VIES_CHECK_URL);

  drafts.push({
    key: 'vies',
    name: vies ?? 'VIES (switched off)',
    purpose: 'Confirms a customer’s EU VAT number so a supply can be zero-rated.',
    dataShared: 'The VAT number being checked. No name, no address, no order.',
    // The Commission, forwarding to the member state that issued the number.
    location: 'BE',
    // A company's VAT number is personal data only where the company is a sole
    // trader, which happens often enough that treating it otherwise would be a
    // convenient assumption rather than a true one.
    carriesPersonalData: true,
    configuredBy: 'VIES_CHECK_URL',
    active: vies !== null,
  });

  // --- Object storage ---------------------------------------------------
  drafts.push({
    key: 'object-storage',
    name: env.STORAGE_DRIVER === 's3' ? 'S3-compatible object storage' : 'Local disk',
    purpose: 'Product media, report exports and Art. 15 personal-data bundles.',
    dataShared:
      'Report exports carry customer names, addresses and order values. A data-subject bundle ' +
      'is every personal fact held about one person, in one file.',
    location: 'SELF_HOSTED',
    carriesPersonalData: true,
    configuredBy: 'STORAGE_DRIVER',
    active: true,
    ...(env.STORAGE_DRIVER === 's3'
      ? {
          note:
            'Name your bucket’s provider and region in your register, and keep the `private/` ' +
            'prefix non-public — that is where export bundles are written.',
        }
      : {}),
  });

  // One place decides where a recipient sits, from one field.
  const entries: ProcessorEntry[] = drafts.map((draft) => ({
    ...draft,
    outsideEea: outside(draft.location),
  }));

  return {
    generatedAt: new Date().toISOString(),
    entries,
    // Only what is switched on AND actually carries something about a person.
    // A list padded with harmless entries is a list nobody reads twice.
    transfersOutsideEea: entries.filter(
      (entry) => entry.active && entry.outsideEea && entry.carriesPersonalData,
    ).length,
  };
}

function providerVendor(name: 'gemini' | 'anthropic'): string {
  return name === 'anthropic' ? 'Anthropic' : 'Google';
}
