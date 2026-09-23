/**
 * Environment loading and validation.
 *
 * The process refuses to boot on a missing or malformed value rather than
 * failing later inside a payment or migration path. Nothing in the codebase
 * reads `process.env` directly - everything imports `env` from here.
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
// The one place the carton's default size is written down. Imported rather
// than repeated, because two copies of a number that decides what a basket
// costs is one copy too many. The domain never imports this file back - see
// the note on the constant itself.
import { DEFAULT_PIECES_PER_CARTON } from '../domain/ordering-unit.js';

loadDotenv();

/** "true"/"1"/"yes" -> true. Anything else falsy. Env vars are always strings. */
const booleanFromString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const intFromString = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

/** Comma-separated origin list -> deduplicated array of exact origins. */
const originList = z
  .string()
  .transform((raw) =>
    Array.from(
      new Set(
        raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    ),
  );

/**
 * The same list, for a surface a deployment may not serve at all.
 *
 * The default is on the INPUT side - an empty comma-separated list - rather
 * than on the output array, because the transform runs after it. An unset
 * variable therefore means "no origins", which is what an installation with no
 * logistics portal wants and is a working state rather than a boot failure.
 */
const optionalOriginList = z.string().default('').pipe(originList);

/**
 * Whether a payment key belongs to a gateway's LIVE environment.
 *
 * A copy of the same one-liner in `modules/payments/provider.ts`, and
 * deliberately a copy: this file is loaded before anything else and importing
 * a module that imports Prisma to answer a question about a string prefix
 * would put the database in the boot path of the configuration.
 */
function isLivePaymentKey(key: string): boolean {
  return key.startsWith('rzp_live_') || key.startsWith('sk_live_') || key.startsWith('pk_live_');
}

const envSchema = z
  .object({
    // --- Runtime ---
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: intFromString(1, 65535).default(4000),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    API_PUBLIC_URL: z.string().url(),

    // --- Frontend origins ---
    ADMIN_WEB_ORIGIN: originList,
    CUSTOMER_WEB_ORIGIN: originList,
    CUSTOMER_WEB_PUBLIC_URL: z.string().url(),
    ADMIN_WEB_PUBLIC_URL: z.string().url(),

    // The logistics partner portal.
    //
    // A third application with a third origin, because it is signed into by a
    // different company's staff. It gets its own CORS entry rather than
    // sharing the console's for the reason the cookie jar is separate: the two
    // audiences must not be able to reach each other by accident.
    //
    // Both default to an empty allowlist and an unset URL, which is a working
    // state: a deployment that has never created a logistics partner has
    // nobody to serve the portal to, and an invitation cannot be sent because
    // no partner exists to invite anybody into. `superRefine` below refuses
    // to start with the feature ON and the URL unset, because an invitation
    // email with no address in it is worse than no invitation.
    LOGISTICS_WEB_ORIGIN: optionalOriginList,
    LOGISTICS_WEB_PUBLIC_URL: z.string().default(''),

    // --- Database ---
    DATABASE_URL: z.string().min(1),
    TEST_DATABASE_URL: z.string().min(1).optional(),
    DB_POOL_SIZE: intFromString(1, 100).default(10),
    DB_CONNECT_TIMEOUT_MS: intFromString(1000, 60_000).default(10_000),

    // --- Sessions / tokens ---
    // 32 bytes of entropy minimum. Short secrets are a real-world breach path,
    // so this is a hard boot failure rather than a warning.
    SESSION_COOKIE_SECRET: z.string().min(32),
    ACCESS_TOKEN_SECRET: z.string().min(32),
    REFRESH_TOKEN_SECRET: z.string().min(32),
    /**
     * How long one access cookie lasts for the storefront, the Seller Hub and
     * the driver app.
     *
     * An hour, not the quarter of an hour it used to be. The number is felt in
     * the Seller Hub more than anywhere else: a seller application is filled in
     * from paperwork that has to be fetched from a drawer, and a token that
     * died while somebody was reading a certificate off a printout took a
     * half-typed step down with it. The refresh cookie below already keeps a
     * used browser signed in silently; this is the ceiling on a browser that is
     * sitting open and idle, and the two are not the same thing.
     *
     * The floor and ceiling stay where they were: an operator who wants the
     * old fifteen minutes back sets it, and nobody can set a day and a half.
     */
    ACCESS_TOKEN_TTL_SECONDS: intFromString(60, 86_400).default(3600),
    /**
     * The same thing for the admin console, kept separate and kept short.
     *
     * Raising the seller's session must not quietly raise the session that can
     * refund an order, read a customer's address and change what every buyer
     * pays. The console is a staff tool used at a desk, where signing in again
     * costs a few seconds; the ceiling that suits a seller filling in a form
     * from a folder is the wrong one here, so it is its own setting with its
     * own default.
     *
     * A deployment that wants one number for everything sets both to it.
     */
    ADMIN_ACCESS_TOKEN_TTL_SECONDS: intFromString(60, 86_400).default(900),
    REFRESH_TOKEN_TTL_SECONDS: intFromString(3600, 31_536_000).default(2_592_000),
    /**
     * The ceiling on one sign-in, however often it is refreshed.
     *
     * `REFRESH_TOKEN_TTL_SECONDS` is a SLIDING window: every rotation issues a
     * token good for another thirty days, so a session used at least once a
     * month never expires. That is comfortable for the person holding it and
     * it is also true of whoever stole the token - a refresh token lifted from
     * a backup, a proxy log or an old machine keeps working for as long as the
     * thief keeps using it, and reuse detection never fires because the
     * legitimate browser has stopped presenting the old one.
     *
     * So the family gets an absolute age as well, measured from the sign-in
     * rather than from the last rotation. Reaching it revokes the family and
     * asks for the password again. Ninety days by default: long enough that a
     * buyer who orders monthly is never interrupted, short enough that a
     * credential cannot outlive the job of the person who held it.
     *
     * Must exceed `REFRESH_TOKEN_TTL_SECONDS`, or the cap would end sessions
     * before their own refresh token expired - checked below.
     */
    SESSION_ABSOLUTE_TTL_SECONDS: intFromString(3600, 31_536_000).default(7_776_000),
    COOKIE_DOMAIN: z.string().default(''),
    COOKIE_SECURE: booleanFromString.default(false),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),

    // --- Encryption at rest ---
    SECRETS_ENCRYPTION_KEY: z.string().min(1),

    // --- Queue / cache ---
    QUEUE_DRIVER: z.enum(['database', 'redis']).default('database'),
    CACHE_DRIVER: z.enum(['memory', 'redis']).default('memory'),
    REDIS_URL: z.string().default(''),
    WORKER_POLL_INTERVAL_MS: intFromString(250, 60_000).default(2000),
    WORKER_CONCURRENCY: intFromString(1, 64).default(4),
    WORKER_LEASE_SECONDS: intFromString(10, 3600).default(60),

    // --- Exchange rates ---
    // Where the price refresh reads rates from. `{base}` is replaced with the
    // business's base currency. The default is a free, keyless feed; it lives
    // in the environment rather than in the admin panel on purpose, so a
    // deployment behind a firewall can point at its own mirror and no
    // administrator can aim the server at an arbitrary URL.
    FX_RATE_URL: z.string().url().default('https://open.er-api.com/v6/latest/{base}'),
    FX_RATE_TIMEOUT_MS: intFromString(1000, 60_000).default(10_000),

    // The European Central Bank's daily euro reference rates. A URL rather
    // than a constant for the same reason as every other outbound address in
    // this file: a deployment behind a firewall mirrors it internally.
    //
    // Which provider is actually used is an admin setting, not an environment
    // variable - it is a pricing decision, and it belongs where the margin and
    // the rounding rule already live. This only says where the ECB adapter
    // looks when it is the one selected.
    FX_ECB_URL: z
      .string()
      .url()
      .default('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'),

    // How many attempts one refresh makes before giving up until the next
    // scheduled run, and the base delay it backs off by. Jittered, so a fleet
    // of workers restarted together does not arrive at the feed in lockstep.
    FX_RATE_MAX_ATTEMPTS: intFromString(1, 10).default(3),
    FX_RATE_RETRY_BASE_MS: intFromString(100, 60_000).default(1_000),

    // Snapshots older than this are pruned by the housekeeping job. Rates are
    // small rows and the history is the audit trail, so the default is long;
    // an order that points at a pruned snapshot keeps its own copy of the rate
    // either way, which is why pruning is safe at all.
    FX_SNAPSHOT_RETENTION_DAYS: intFromString(30, 3650).default(730),

    // --- EU VAT number checking (VIES) ---
    //
    // The Commission's REST front door onto the twenty-seven national VAT
    // registers. A URL rather than a fixed host, on the same reasoning as the
    // geocoder above: an installation behind a firewall can point at its own
    // proxy, and an empty string switches checking off entirely.
    //
    // Switching it off does not break anything - it makes every VAT number
    // unverified, and an unverified number is charged VAT rather than
    // zero-rated. That is the safe direction: it costs the customer cash flow,
    // where the other direction costs the seller the tax.
    //
    // {country} is the member state prefix (EL for Greece, not GR) and
    // {number} the rest.
    VIES_CHECK_URL: z
      .string()
      .default('https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{country}/vat/{number}'),
    VIES_TIMEOUT_MS: intFromString(1000, 60_000).default(10_000),

    // --- Object storage ---
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('.storage'),
    /**
     * Where a stored PUBLIC object is served from.
     *
     * Two shapes are legal, and the difference is which browsers can see a
     * picture:
     *
     *   - An **absolute URL** — `https://cdn.example.com` — when an object
     *     store or a CDN serves the bytes. That is the production shape, and
     *     the only one that makes sense when the files do not live next to the
     *     API.
     *   - A **root-relative path** — `/media` — when the bytes are served on
     *     the same origin as the page, by a proxy in front of the API. Every
     *     picture's URL is then correct on whatever origin the page was
     *     opened from.
     *
     * The second is what development wants, and getting it wrong is invisible
     * on the machine that made the upload. An absolute `http://localhost:4000`
     * is baked into the URL the API hands back; a browser anywhere else — a
     * phone on the same network, anyone looking through a tunnel — resolves
     * `localhost` to their OWN device, and an HTTPS page refuses an `http://`
     * image outright. The upload succeeds, the row is written, and the seller
     * who just added a photograph sees an empty box.
     *
     * A protocol-relative `//host/...` is refused: it points at another origin
     * while looking like a path, which is not something a configuration file
     * should be able to say by accident.
     */
    STORAGE_PUBLIC_BASE_URL: z
      .string()
      .refine(
        (value) => /^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value),
        'Must be an absolute http(s) URL, or a root-relative path such as /media.',
      ),
    S3_ENDPOINT: z.string().default(''),
    S3_REGION: z.string().default(''),
    S3_BUCKET: z.string().default(''),
    S3_ACCESS_KEY_ID: z.string().default(''),
    S3_SECRET_ACCESS_KEY: z.string().default(''),
    S3_FORCE_PATH_STYLE: booleanFromString.default(true),
    UPLOAD_MAX_BYTES: intFromString(1024, 104_857_600).default(5_242_880),
    /**
     * The ceiling for a VIDEO, separate from the one for a photograph.
     *
     * A shared limit would force an operator who wants to accept one
     * thirty-second product video to raise the photograph ceiling to match -
     * and the photograph ceiling is what stops somebody uploading a RAW file
     * per product. 64 MB by default: enough for a short clip at 1080p,
     * nowhere near enough for a feature film.
     */
    UPLOAD_VIDEO_MAX_BYTES: intFromString(1024, 536_870_912).default(67_108_864),
    /**
     * User-supplied documents are scanned synchronously before storage.
     * `disabled` is for local development only; production refuses to boot
     * without ClamAV so a deployment cannot silently accept unscanned files.
     */
    MALWARE_SCANNER_DRIVER: z.enum(['disabled', 'clamav']).default('disabled'),
    MALWARE_SCANNER_SOCKET: z.string().min(1).default('/run/clamav/clamd.ctl'),
    MALWARE_SCANNER_TIMEOUT_MS: intFromString(1000, 120_000).default(30_000),

    // --- Email ---
    EMAIL_DRIVER: z.enum(['log', 'smtp']).default('log'),
    EMAIL_FROM_NAME: z.string().min(1),
    EMAIL_FROM_ADDRESS: z.string().email(),
    SMTP_HOST: z.string().default(''),
    SMTP_PORT: intFromString(1, 65535).default(587),
    SMTP_USER: z.string().default(''),
    SMTP_PASSWORD: z.string().default(''),
    SMTP_SECURE: booleanFromString.default(false),

    // --- Payments ---
    PAYMENT_DEFAULT_PROVIDER: z.enum(['razorpay', 'stripe']).default('razorpay'),
    RAZORPAY_KEY_ID: z.string().default(''),
    RAZORPAY_KEY_SECRET: z.string().default(''),
    RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
    /// The PUBLISHABLE key (pk_...). Sent to the browser; not a secret.
    STRIPE_PUBLISHABLE_KEY: z.string().default(''),
    STRIPE_SECRET_KEY: z.string().default(''),
    STRIPE_WEBHOOK_SECRET: z.string().default(''),
    PAYMENT_LINK_TTL_HOURS: intFromString(1, 8760).default(72),
    /**
     * Make every payment succeed, without a gateway or a webhook.
     *
     * FOR TESTING THIS SOFTWARE, AND FOR NOTHING ELSE. With it on, the
     * storefront can settle any order awaiting payment by asking for it, and
     * the order is confirmed exactly as a captured payment confirms it -
     * same state machine, same ERP push, same audit trail - so a tester sees
     * the real consequences of a payment rather than a green tick.
     *
     * It exists because the honest path is unreachable on a laptop. An order
     * is confirmed only by a signature-verified webhook, and a gateway cannot
     * reach `localhost`, so a developer who pays with a test card watches the
     * order sit in PENDING_PAYMENT forever and every screen after checkout is
     * untestable.
     *
     * Three guards, all below in the refinements: it is refused outright in
     * production, refused next to a live credential, and off by default. The
     * webhook path is untouched - this is a second, clearly-marked door, not
     * a weakening of the first one.
     */
    PAYMENT_MOCK_SUCCESS: booleanFromString.default(false),

    // --- Business defaults ---
    DEFAULT_CURRENCY: z.string().length(3).toUpperCase().default('INR'),
    DEFAULT_TIMEZONE: z.string().min(1).default('Asia/Kolkata'),

    // --- Feature flags ---
    FEATURE_CUSTOMER_SELF_REGISTRATION: booleanFromString.default(false),
    // Whether a self-registered account waits for a member of staff before it
    // can sign in. On by default, and deliberately so: this is a B2B catalogue
    // with per-customer prices, purchasing limits and credit terms, so "anyone
    // who can receive an email may buy" is the wrong default even where the
    // registration form itself is open. Set it to false only where the
    // storefront is genuinely open to the public.
    CUSTOMER_SELF_REGISTRATION_REQUIRES_APPROVAL: booleanFromString.default(true),
    FEATURE_STOCK_RESERVATIONS: booleanFromString.default(true),
    FEATURE_ORDER_APPROVALS: booleanFromString.default(false),
    FEATURE_RECURRING_ORDERS: booleanFromString.default(true),
    /// Buy Later: one delivery, on a date the customer picks.
    ///
    /// Separate from FEATURE_RECURRING_ORDERS because they are separate
    /// promises to a customer. A deployment can offer "deliver this next
    /// Tuesday" without offering a standing authority to charge, and plenty
    /// will want to.
    FEATURE_SCHEDULED_ORDERS: booleanFromString.default(true),
    /// Whether EVERY published product may be put on a repeat purchase.
    ///
    /// On: eligibility is not asked per product, and anything a customer can
    /// buy they can also schedule. Off: only products an administrator has
    /// ticked `isRecurringEligible` on may be scheduled, which is what this
    /// software did before the flag existed.
    ///
    /// On by default, because the per-product flag defaults to FALSE and the
    /// two together meant a freshly installed store offered a repeat-purchase
    /// button that refused every basket put through it. A deployment that
    /// genuinely sells things it will not repeat - a clearance line, a
    /// one-per-customer device, anything sold against a single tender - turns
    /// this off and curates the list.
    ///
    /// A setting rather than a decision made here, because which of those two
    /// a buyer of this software is depends entirely on what they sell.
    FEATURE_SCHEDULE_ANY_PRODUCT: booleanFromString.default(true),
    /// Auto-pay: charging a stored card while the customer is away.
    ///
    /// Off by default, and that default is the important part. Turning it on
    /// means this deployment takes money from people who are not present, so
    /// it should be a decision somebody made rather than a behaviour they
    /// inherited by installing the software. It also needs Stripe connected -
    /// the enrolment path refuses without it, rather than storing a card it
    /// could never charge.
    FEATURE_SUBSCRIPTION_AUTOPAY: booleanFromString.default(false),

    // --- Scheduled and recurring orders ---
    //
    // How far the total may drift from what the customer was quoted before the
    // charge needs re-confirming. Checked as a percentage AND as an absolute
    // floor, and the more generous of the two wins: 2% of a small basket is a
    // few minor units, and holding an occurrence over a rounding difference
    // teaches customers to ignore the notification.
    //
    // A plan may override both. These are the deployment's defaults for plans
    // that do not.
    SCHEDULE_PRICE_TOLERANCE_PERCENT: z.coerce.number().min(0).max(100).default(5),
    SCHEDULE_PRICE_TOLERANCE_MINOR: intFromString(0, 100_000_000).default(500),
    /// How long before a run a plan stops accepting edits, in minutes.
    ///
    /// An edit inside this window would race the worker: the customer sees the
    /// old basket while the engine is already pricing the new one.
    SCHEDULE_EDIT_CUTOFF_MINUTES: intFromString(0, 20_160).default(1440),
    /// How far ahead occurrences are materialised, in days.
    ///
    /// Rows have to exist before the customer can skip or edit them, so this
    /// is what makes "skip my next delivery" possible at all. Kept short: a
    /// year of pre-built rows would be a year of rows to migrate whenever a
    /// plan changes.
    SCHEDULE_MATERIALISE_AHEAD_DAYS: intFromString(1, 365).default(35),
    /// How long before a charge the reminder goes out, in hours.
    ///
    /// Has to be comfortably longer than the edit cutoff, or the reminder
    /// arrives telling the customer they can still change something they
    /// cannot. Validated below.
    SCHEDULE_REMINDER_LEAD_HOURS: intFromString(1, 720).default(48),
    /// How many times one occurrence's PAYMENT may be attempted.
    ///
    /// Counted apart from validation attempts: banks read repeated declines as
    /// a signal about the card, so a held occurrence must not spend the card's
    /// budget. Three is Stripe's own guidance for off-session retries.
    SCHEDULE_MAX_PAYMENT_ATTEMPTS: intFromString(1, 10).default(3),
    /// How much notice the first delivery of a plan needs, in CALENDAR days.
    ///
    /// Seven, and seven is a business decision rather than a fact about
    /// software - which is exactly why it is a setting. A standing order is
    /// not a same-day courier: the basket is repriced and revalidated before
    /// it runs, stock is reserved, and a card charge or a payment link has to
    /// clear. On a catalogue of sterile consumables picked against a purchase
    /// order, a week is the window the business actually works to, and
    /// offering a buyer tomorrow would be offering something nobody can
    /// supply.
    ///
    /// **Calendar days, counted on the customer's own clock**, never
    /// `7 * 24 * 3600 * 1000` milliseconds. The two disagree twice a year in
    /// every zone that observes DST, and they disagree permanently for any
    /// buyer whose today is not the server's today. See
    /// `domain/delivery-dates.ts`.
    ///
    /// Zero is allowed and means "no notice period", which is a legitimate
    /// configuration for a deployment shipping from stock it holds in the same
    /// building as the buyer. The storefront reads this from /config, so
    /// nothing about the figure is hard-coded in a browser.
    SCHEDULE_MIN_NOTICE_DAYS: intFromString(0, 365).default(7),

    // --- The selling unit ---
    //
    // How many pieces are in one carton.
    //
    // This shop sells by the carton and by nothing else: a buyer chooses a
    // number of cartons, and the piece count that reaches the warehouse, the
    // invoice and the ERP is that number multiplied by this one. It is a
    // setting rather than a constant because the next deployment of this
    // software packs its own product its own way, and a figure compiled into
    // a browser bundle is a figure the operator who bought it cannot change.
    //
    // Changing it does not rewrite history. Every basket line, plan line and
    // order line keeps the carton size it was agreed at, so "2 cartons" on an
    // invoice from last year still means the pieces it meant last year.
    //
    // The storefront reads it from /config and shows it beside every price.
    PIECES_PER_CARTON: intFromString(1, 1_000_000).default(DEFAULT_PIECES_PER_CARTON),

    // --- Per-seller storefronts ---
    //
    // The domain seller subdomains hang off: `uboss.example` makes
    // `northwind.uboss.example` the storefront of the seller whose slug is
    // `northwind`. The bare domain stays the operator's own shop.
    //
    // EMPTY TURNS THE WHOLE THING OFF, which is the default and the state every
    // existing deployment is in. A single-supplier shop has no seller
    // storefronts to serve, and a host it does not recognise must never be
    // guessed at — an unset value means every request is the operator's,
    // exactly as it was before this existed.
    //
    // A setting rather than a constant for the usual reason: the business that
    // buys this software runs it on its own domain, and one compiled into the
    // server is one they cannot change.
    SELLER_STOREFRONT_DOMAIN: z.string().trim().toLowerCase().default(''),

    // --- Fulfilment quotes ---
    //
    // How long a warehouse option stays an offer, in minutes.
    //
    // Short on purpose. A quote holds a stock figure and a price, and stock is
    // the fastest-moving input in this system - it changes every time anybody
    // else checks out. Fifteen minutes is long enough to read a checkout page,
    // add an address and choose a card, and short enough that "the option you
    // picked has moved" is rare rather than routine.
    //
    // Expiry is never silent: checkout refuses a lapsed quote with
    // FULFILMENT_QUOTE_EXPIRED and the storefront re-asks, because a quote
    // quietly repriced at payment is a customer charged something nobody
    // showed them.
    FULFILMENT_QUOTE_TTL_MINUTES: intFromString(1, 1440).default(15),

    // --- ERP order hand-off ---
    //
    // The connection an order is pushed to, by name, matching an
    // IntegrationConnection row an administrator has created and activated.
    // Empty means no ERP push, which is a working state: the platform order is
    // created, paid and fulfilled exactly as it is today.
    //
    // A name rather than an id because the id is a ULID nobody can type, and
    // this is configuration a person writes into a file.
    ERP_ORDER_CONNECTION_NAME: z.string().default(''),
    /// Path appended to that connection's base URL to create an order.
    ERP_ORDER_PATH: z.string().default('/orders'),
    /// Path asked whether the ERP can supply a set of SKUs, before charging.
    ///
    /// Empty switches the pre-charge check off, which is a legitimate choice
    /// for an ERP whose stock this system already mirrors closely. Where it is
    /// set, an unreachable ERP holds the occurrence rather than charging on an
    /// assumption.
    ERP_STOCK_PATH: z.string().default('/stock/availability'),
    /// Where the ERP's identifier for the created order is found in its
    /// response, as a dotted path. ERPs disagree about this more than about
    /// anything else, so it is configuration rather than a guess.
    ERP_ORDER_REFERENCE_PATH: z.string().default('id'),
    /// The header the ERP reads an idempotency key from.
    ERP_IDEMPOTENCY_HEADER: z.string().default('Idempotency-Key'),
    /// How many times an ERP push is retried before it needs a person.
    ///
    /// Generous, because the occurrence is already paid when this runs: the
    /// alternative to retrying is a customer whose money has gone and whose
    /// order the warehouse cannot see.
    ERP_ORDER_MAX_ATTEMPTS: intFromString(1, 50).default(8),
    /// Whether stock must be confirmed against the ERP before a card is
    /// charged.
    ///
    /// On where an ERP is connected: charging for something the ERP will refuse
    /// to ship is the worst of the available outcomes. With no ERP configured
    /// this has no effect.
    ERP_VERIFY_STOCK_BEFORE_CHARGE: booleanFromString.default(true),

    // --- Configurable ERP connections ---
    //
    // Everything above this comment configures the ERP connector wired through
    // environment variables. The settings below govern the other kind: a
    // connection an administrator creates under Settings -> ERP, whose address,
    // endpoints, credentials and field names all live in the database. Nothing
    // here names an ERP, because nothing in a deployment's configuration needs
    // to - that is the whole point of the feature.
    //
    // The master switch. Off means the Integrations screens are hidden, the
    // routes refuse with FEATURE_DISABLED, no polling job is enqueued, and the
    // webhook endpoint 404s. An installation that has not thought about
    // customers reaching outbound to their own systems should not have that
    // happening by default, so it is opt-in.
    FEATURE_ERP_INTEGRATION: booleanFromString.default(false),
    /// How many ERP connections one customer may hold.
    ///
    /// A sandbox and a live one is the ordinary case; five is room for a
    /// migration without letting one account create work for the poller
    /// without limit.
    ERP_MAX_CONNECTIONS: intFromString(1, 50).default(5),
    /// Attempts at one customer-ERP operation before it needs a person.
    ///
    /// Lower than ERP_ORDER_MAX_ATTEMPTS because these hit a system the
    /// customer runs themselves: an ERP that has refused six times is telling
    /// its owner something, and continuing to hammer it is not our decision to
    /// make on their behalf. The paid-but-unpushed case is exempt and uses the
    /// operator ceiling - see `pushOrderToErp`.
    ERP_MAX_ATTEMPTS: intFromString(1, 20).default(6),
    /// Records one inventory sync will read from a customer's ERP.
    ///
    /// A ceiling on memory and on how long a worker slot is held, not a
    /// business rule. A feed longer than this is paged where the customer's
    /// ERP supports paging and truncated with a warning where it does not.
    ERP_MAX_SYNC_RECORDS: intFromString(100, 100_000).default(5000),
    /// Per-record failures stored for one sync run.
    ///
    /// Beyond this the run is marked FAILED with one reason. Fifty thousand
    /// rows nobody will read is not a better diagnostic than "the whole feed
    /// was rejected".
    ERP_MAX_RECORD_ERRORS: intFromString(1, 1000).default(50),
    /// Consecutive failures before a connection is taken out of service.
    ///
    /// It moves to ERROR and stops being called until a test passes. Without
    /// this, a customer whose ERP has been switched off for a fortnight gets a
    /// poll against it every hour for a fortnight.
    ERP_FAILURE_THRESHOLD: intFromString(1, 100).default(5),

    // Whether a customer's ERP address may be on a private or loopback
    // network.
    //
    // FALSE, and `superRefine` below refuses to start a production process
    // with it true. It exists for one case: a developer pointing a connection
    // at a mock ERP on localhost:9000. Turning it on in production hands
    // anybody who can save a connection a way to make this server call
    // 169.254.169.254 and read the instance's cloud credentials back out of a
    // sync error - which is why it is not merely discouraged but refused.
    //
    // With it off, `outbound-http.ts` resolves every hostname itself, checks
    // every address it resolves to, pins the socket to one that passed, and
    // re-validates every redirect. See that file's header.
    ALLOW_PRIVATE_ERP_TARGETS: booleanFromString.default(false),

    // --- A buyer's own ERP ---------------------------------------------------
    //
    // Everything above configures the SELLER's ERP: the operator connects one
    // and every order goes to it. This block is the other direction - a buyer
    // business connecting its own SAP, monday.com or in-house system so that
    // what it buys here appears there.
    //
    // The master switch. Off means the account area's integration screens are
    // hidden, every customer-facing route refuses with FEATURE_DISABLED, no
    // dispatch or polling job is enqueued, and the inbound webhook endpoint
    // 404s. Opt-in, because an installation that has not thought about its
    // customers pointing this server at addresses of their own choosing should
    // not discover the feature by finding it already on.
    FEATURE_CUSTOMER_ERP: booleanFromString.default(false),

    /// How many connections one buyer organisation may hold.
    ///
    /// A sandbox and a production one is the ordinary case, and a buyer
    /// mid-migration legitimately wants both SAP and monday at once. Five is
    /// room for that without letting one tenant create unbounded work for the
    /// poller.
    CUSTOMER_ERP_MAX_CONNECTIONS_PER_ORG: intFromString(1, 20).default(5),

    /// Attempts at one event before it goes to the dead-letter state.
    ///
    /// Every attempt uses the SAME idempotency key, so this is a bound on
    /// noise rather than a risk of duplication. Six because an ERP that has
    /// refused six times over an expanding backoff is telling its owner
    /// something, and hammering it further is not our decision to make on
    /// their behalf.
    CUSTOMER_ERP_MAX_ATTEMPTS: intFromString(1, 20).default(6),

    /// The first retry delay, in seconds. Doubled each attempt, capped by
    /// CUSTOMER_ERP_RETRY_MAX_SECONDS, and overridden entirely whenever the
    /// ERP sent a `Retry-After` - an ERP that says "wait 300 seconds" and gets
    /// another request in five has been told by our behaviour that its rate
    /// limiting does not work.
    CUSTOMER_ERP_RETRY_BASE_SECONDS: intFromString(1, 3600).default(30),
    CUSTOMER_ERP_RETRY_MAX_SECONDS: intFromString(60, 86_400).default(3600),

    /// Consecutive failures before a connection is taken out of service.
    ///
    /// It moves to FAILED and stops being called until a test passes. Without
    /// it, a buyer whose ERP has been switched off for a fortnight gets a poll
    /// against it every hour for a fortnight.
    CUSTOMER_ERP_FAILURE_THRESHOLD: intFromString(1, 100).default(5),

    /// Records one inbound pass will read from a buyer's ERP. A ceiling on
    /// memory and on how long a worker slot is held, not a business rule.
    CUSTOMER_ERP_MAX_SYNC_RECORDS: intFromString(100, 100_000).default(5000),

    /// Bytes of a single ERP response held in memory. Smaller than the
    /// outbound default because these are somebody else's systems answering
    /// somebody else's queries, and a buyer whose ERP returns a 50MB catalogue
    /// should get a clear refusal rather than a worker that swells.
    CUSTOMER_ERP_MAX_RESPONSE_BYTES: intFromString(64_000, 8_388_608).default(2_097_152),

    /// How long an OAuth authorisation-code flow may stay in flight, in
    /// seconds. The window between "the buyer pressed Connect" and "their ERP
    /// redirected them back" - long enough to sign in and read a consent
    /// screen, short enough that an abandoned flow is not a standing invitation.
    CUSTOMER_ERP_OAUTH_STATE_TTL_SECONDS: intFromString(120, 3600).default(900),

    /// Where an ERP sends the buyer back to after authorising. Must be an
    /// address this deployment serves; it is compared byte for byte at token
    /// exchange, and it is what the buyer registers with their own ERP.
    ///
    /// Empty means "derive it from API_PUBLIC_URL", which is right for every
    /// ordinary deployment. It exists for installations behind a gateway whose
    /// public address is not the API's own.
    CUSTOMER_ERP_OAUTH_REDIRECT_URI: z.string().default(''),

    /// The operator's registered monday.com app.
    ///
    /// monday production connections use an OAuth app registered by whoever
    /// runs this installation, not by each buyer - that is how monday's
    /// marketplace works. The SECRET is the operator's and lives here; the
    /// buyer never sees it and never types it. Empty means this deployment has
    /// not registered an app, and the monday connector then offers only the
    /// personal-token path, which is restricted to sandbox connections.
    MONDAY_OAUTH_CLIENT_ID: z.string().default(''),
    MONDAY_OAUTH_CLIENT_SECRET: z.string().default(''),
    /// Least privilege, and shown to the buyer before they authorise. Widen
    /// this and every buyer is asked for more than they were before, so it is
    /// configuration rather than a constant.
    MONDAY_OAUTH_SCOPES: z
      .string()
      .default('boards:read boards:write workspaces:read me:read'),

    /// Host suffixes a buyer's ERP address is allowed to end in.
    ///
    /// Empty - the default - means any publicly routable host, which is what
    /// the SSRF guard already enforces and is the right posture for a product
    /// sold to businesses whose ERPs live at addresses nobody here can predict.
    ///
    /// An operator with a stricter policy sets this to a comma-separated list
    /// (`sap.example.com,.monday.com`) and buyers are then held to it. A leading
    /// dot means "this domain and its subdomains"; anything else is an exact
    /// host. It is a second lock on top of the address checks, never a
    /// replacement for them.
    CUSTOMER_ERP_ALLOWED_HOST_SUFFIXES: z
      .string()
      .default('')
      .transform((raw) =>
        raw
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      ),

    /// How long an organisation invitation stays valid, in hours.
    CUSTOMER_ERP_INVITE_TTL_HOURS: intFromString(1, 720).default(168),

    // --- A SELLER's own accounting system (TallyPrime) -----------------------
    //
    // The third ERP feature in this file, and it is neither of the other two.
    // `FEATURE_ERP_INTEGRATION` above is the OPERATOR's warehouse system;
    // `FEATURE_CUSTOMER_ERP` is a BUYER's purchasing system; this is a SELLER's
    // accounting system, one per seller, posting that seller's own sales into
    // their own books. They share no table, no job type and no retry budget.
    //
    // Off means the Seller Hub's ERP screens are hidden, every route refuses
    // with FEATURE_DISABLED, no dispatch job is enqueued, and the bridge
    // endpoint 404s. Opt-in, like the other two.
    FEATURE_SELLER_ERP: booleanFromString.default(false),

    /// How many Tally connections one seller may hold.
    ///
    /// Two is the ordinary case at a financial year boundary - last year's
    /// company and this year's - and a seller with several trading entities
    /// legitimately wants one each. Five is room for that without letting one
    /// tenant create unbounded work for the dispatcher.
    SELLER_ERP_MAX_CONNECTIONS: intFromString(1, 20).default(5),

    /// How long a pairing code is good for, in minutes.
    ///
    /// SHORT on purpose. A pairing code IS a credential for the whole of its
    /// life - it is the one thing standing between a stranger's bridge and a
    /// seller's books - and the whole workflow is "generate it, walk to the
    /// machine, paste it". Fifteen minutes covers that walk. An hour covers a
    /// code left on a screen in an open office over lunch.
    SELLER_ERP_PAIRING_TTL_MINUTES: intFromString(2, 120).default(15),

    /// Wrong guesses at one pairing code before it is burned.
    ///
    /// A code short enough for a person to type is short enough to guess given
    /// unlimited goes. Five is generous for a typo and useless for a search.
    SELLER_ERP_PAIRING_MAX_ATTEMPTS: intFromString(1, 20).default(5),

    /// Pairing codes one seller may generate per hour. A second lock on the
    /// same door: burning a code after five guesses is worth little if a
    /// thousand fresh ones can be minted.
    SELLER_ERP_PAIRING_RATE_PER_HOUR: intFromString(1, 100).default(10),

    /// How long a bridge token lasts before it must be rotated, in days.
    ///
    /// The agent rotates on its own well before this, so a seller never
    /// normally meets it. It is the backstop for a machine that was paired,
    /// forgotten, and left running in a cupboard for two years.
    SELLER_ERP_BRIDGE_TOKEN_TTL_DAYS: intFromString(1, 3650).default(180),

    /// How long the bridge holds a claimed task before the lease expires, in
    /// seconds.
    ///
    /// The same lease pattern `JobQueue` uses, and for the same MariaDB 10.4
    /// reason - no SKIP LOCKED, so claiming is a conditional UPDATE. A bridge
    /// that dies mid-task releases the work after this rather than stranding
    /// it; too short and a slow Tally has its work taken off it mid-post.
    SELLER_ERP_TASK_LEASE_SECONDS: intFromString(30, 1800).default(300),

    /// Tasks the bridge may claim in one poll. A ceiling on how much one
    /// seller's agent holds at once, not a business rule.
    SELLER_ERP_TASK_BATCH_SIZE: intFromString(1, 50).default(5),

    /// Attempts at one event before it is dead-lettered.
    ///
    /// Every attempt uses the SAME idempotency key, so this bounds noise
    /// rather than risking duplication. Eight because an accounting event
    /// matters more than most - losing one is a sale missing from somebody's
    /// books - and because the backoff has reached hours by then anyway.
    SELLER_ERP_MAX_ATTEMPTS: intFromString(1, 30).default(8),

    /// The first retry delay, in seconds. Doubled each attempt with full
    /// jitter and capped at an hour - see `retryDelaySeconds`.
    SELLER_ERP_RETRY_BASE_SECONDS: intFromString(1, 3600).default(30),

    /// Consecutive failures before a connection's circuit opens.
    ///
    /// It stops handing out work until a test passes. Without it, a seller
    /// whose Tally has been closed for a fortnight gets every queued job
    /// attempted against it on every pass for a fortnight.
    SELLER_ERP_FAILURE_THRESHOLD: intFromString(1, 100).default(5),

    /// Whether a seller may point this server straight at a Tally address,
    /// instead of running the bridge.
    ///
    /// FALSE, and it should stay false on anything reachable from the
    /// internet. TallyPrime's HTTP listener has NO AUTHENTICATION: anyone who
    /// can reach the port can read the whole ledger and post vouchers into it.
    /// There is therefore no address a seller can safely publish, and
    /// `localhost:9000` from this server is THIS server rather than theirs.
    ///
    /// It exists for one deployment shape: a marketplace running inside the
    /// same private network or VPN as the seller's Tally, on hosts the
    /// operator controls. Turning it on without `SELLER_ERP_DIRECT_HOST_SUFFIXES`
    /// is refused at startup.
    SELLER_ERP_ALLOW_DIRECT_MODE: booleanFromString.default(false),

    /// Host suffixes a direct-mode Tally address is allowed to end in.
    ///
    /// Required when direct mode is on, and deliberately NOT defaulted to
    /// anything: an allowlist that defaults to "everything" is not an
    /// allowlist. A leading dot means "this domain and its subdomains";
    /// anything else is an exact host. It sits on top of the SSRF guard, never
    /// in place of it.
    SELLER_ERP_DIRECT_HOST_SUFFIXES: z
      .string()
      .default('')
      .transform((raw) =>
        raw
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      ),

    /// Bytes of one Tally reply held in memory.
    ///
    /// A master list from a large company is the biggest legitimate payload; a
    /// voucher acknowledgement is a few kilobytes. Matches MAX_XML_BYTES in
    /// `tally/xml.ts`, which refuses anything larger before parsing.
    SELLER_ERP_MAX_RESPONSE_BYTES: intFromString(64_000, 33_554_432).default(8_388_608),

    // --- Auto-pay ---
    //
    // Separate from FEATURE_SUBSCRIPTION_AUTOPAY, which governs whether a
    // scheduled plan may charge a stored card. This one governs the customer's
    // own standing authority: a ceiling per transaction, a threshold above
    // which they want to be asked, and the consent that makes any of it lawful.
    //
    // A deployment may reasonably want saved cards for schedules and no
    // standing authority beyond them, which is why the two are not one flag.
    FEATURE_CUSTOMER_AUTOPAY: booleanFromString.default(false),
    /// The consent text version a customer's stored acceptance is recorded
    /// against.
    ///
    /// Bumping it does NOT invalidate existing consent by itself - that would
    /// silently stop every customer's auto-pay on a deployment - but it is
    /// what lets an operator tell who agreed to which wording, which is the
    /// question asked when a charge is disputed.
    AUTOPAY_CONSENT_VERSION: z.string().default('v1'),
    /// A platform-wide ceiling on any single off-session charge, in minor
    /// units of the order's own currency.
    ///
    /// Applied on top of whatever the customer set, never instead of it, and
    /// zero means no platform ceiling. It is the operator's backstop against a
    /// pricing bug turning into a five-figure charge nobody authorised.
    AUTOPAY_PLATFORM_MAX_MINOR: intFromString(0, 100_000_000_000).default(0),

    // --- Admin second factor and sign-in location ---
    // On by default and impossible to disable in production. The switch exists
    // only so integration tests that are about unrelated business flows do not
    // all have to manufacture a fresh TOTP code for each session.
    FEATURE_ADMIN_MFA: booleanFromString.default(true),
    //
    // Off by default: precise employee location is not necessary for ordinary
    // authentication and enabling it can trigger a DPIA, employment-law
    // consultation and notice obligations. A deployment with a documented,
    // proportionate need may opt in deliberately.
    //
    // The Geolocation API only exists in a secure context, so an admin panel
    // served over plain HTTP on anything but localhost can never satisfy this
    // and every member of staff would be locked out. That deployment sets
    // FEATURE_ADMIN_LOGIN_LOCATION=false, or, better, puts the panel behind
    // HTTPS.
    //
    // The reverse lookup turns coordinates into a place name and is the one
    // part that leaves the building - a URL rather than a hard-coded host so an
    // installation behind a firewall can point at its own geocoder, and an
    // empty string switches it off entirely, leaving the notification to show
    // coordinates. The default is OpenStreetMap's, whose usage policy asks for
    // an identifying User-Agent and no bulk querying; one lookup per admin
    // sign-in is well inside it.
    FEATURE_ADMIN_LOGIN_LOCATION: booleanFromString.default(false),
    GEOCODE_REVERSE_URL: z
      .string()
      .default('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat={lat}&lon={lon}'),
    GEOCODE_TIMEOUT_MS: intFromString(500, 30_000).default(5000),

    // --- Warehouse map ---
    //
    // The console can draw its warehouses on a map. Two settings, and the
    // defaults are chosen so that an installation nobody has configured shows
    // something honest rather than something broken.
    //
    // MAP_TILE_URL is empty by default, and empty is a working state: the
    // Warehouses screen plots its markers on a plain grid with no tiles behind
    // them. That default is deliberate rather than lazy. A tile request carries
    // the coordinates being looked at to whoever serves it, and this software is
    // installed and run by the company that bought it - so where a deployment's
    // warehouses are is not a fact this repository gets to send to a third
    // party on that company's behalf. Set it and the tiles appear.
    //
    // Any XYZ raster tile service works; the {z}/{x}/{y} placeholders are
    // substituted by the browser. OpenStreetMap's own is
    // https://tile.openstreetmap.org/{z}/{x}/{y}.png, whose tile usage policy
    // requires attribution and forbids bulk downloading - so a deployment that
    // points here must also set MAP_TILE_ATTRIBUTION, and an installation with
    // many staff should use its own tile server or a commercial one.
    //
    // RASTER TILES ARE ALWAYS LABELLED IN THE LOCAL LANGUAGE. Place names are
    // drawn into the image before it is sent, so Greece arrives as Ελλάς and
    // China as 中国 and the browser can do nothing about it. A deployment that
    // needs one language across the whole world wants MAP_STYLE_URL below.
    MAP_TILE_URL: z.string().default(''),
    // Rendered in the corner of the map, as every tile licence requires. Kept
    // as free text rather than a lookup table of known providers: the operator
    // knows what their provider asks for, and this software cannot.
    MAP_TILE_ATTRIBUTION: z.string().default(''),

    // Vector tiles, as a MapLibre style URL. The same map, drawn in the
    // browser from data rather than delivered as finished pictures.
    //
    // **This is the setting that gets every label into one language.** A
    // vector tile carries a place's names as fields - `name`, `name:en`,
    // `name:de` - and the panel points every label at `name:en`, so a map
    // opened in Pune and a map opened in Athens both read "Greece". With the
    // raster tiles above that is not possible at any price.
    //
    // What goes here is a style JSON URL, not a tile template: the style is
    // what names the tile source, the fonts and every layer's paint. Keyless
    // public ones exist - OpenFreeMap's
    // https://tiles.openfreemap.org/styles/liberty is planet-wide
    // OpenStreetMap data - commercial providers hand out one with a key in the
    // query string, and an installation behind a firewall points this at its
    // own. **Vector wins over MAP_TILE_URL when both are set**, and Google
    // still wins over both.
    MAP_STYLE_URL: z.string().default(''),
    // An attribution line added to whatever the style already declares.
    //
    // Usually left empty, and that is a different story from
    // MAP_TILE_ATTRIBUTION above rather than the same one: a style JSON names
    // its own sources and each source carries its own attribution, so the
    // credit reaches the corner of the map without this being set. It is here
    // for the deployment whose self-hosted style declares none, and for a
    // licence that asks for a line of its own.
    MAP_STYLE_ATTRIBUTION: z.string().default(''),

    // Satellite imagery, as the ground the map is drawn on.
    //
    // An XYZ raster template like MAP_TILE_URL, and empty by default for the
    // same reason everything else here is: a tile request tells whoever serves
    // it which part of the world is being looked at, and where a deployment's
    // warehouses are is not a fact this repository sends to a third party on
    // the operator's behalf.
    //
    // **It is the ground, not the whole map.** Set it alongside MAP_STYLE_URL
    // and the imagery goes underneath that style's roads, borders and labels -
    // the hybrid view, where a warehouse sits on a photograph of the estate it
    // is on and the street it is reached by is still named, still in one
    // language. Set it with no style and the map is imagery and markers, which
    // is honest but hard to read. Set it alongside MAP_TILE_URL and it is
    // ignored: those tiles are already a finished picture of the ground, and
    // two grounds is one too many.
    //
    // Any XYZ imagery service works; {z}/{x}/{y} are substituted by the
    // browser. Esri's World Imagery -
    // https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
    // - is keyless and global, and its terms require the credit line, so a
    // deployment pointing here must also set MAP_SATELLITE_ATTRIBUTION.
    MAP_SATELLITE_URL: z.string().default(''),
    MAP_SATELLITE_ATTRIBUTION: z.string().default(''),

    // How far a warehouse delivers, when the warehouse itself does not say.
    //
    // A setting rather than a constant because it is a commercial promise, not
    // a technical limit: 500 km is a day's run for a warehouse with its own
    // fleet, and nothing like the right number for a city depot handing over
    // to a bike courier.
    //
    // **This is the fallback, not the rule.** Since geofencing, a warehouse
    // carries its own `deliveryRadiusKm`, and this is what applies to every
    // warehouse that has not been given one. That is the useful way round: an
    // operator moves the whole business's promise by editing one line here,
    // and still overrides the two buildings that are different.
    //
    // The panel asks for this radius by default and the endpoint accepts any
    // value up to its own ceiling, so an operator can also try a different one
    // without changing this.
    //
    // Nothing about it is hard-coded in the frontend. The browser is told the
    // radius it should ask for by /config, the same way it is told everything
    // else it must not assume.
    DELIVERY_COVERAGE_RADIUS_KM: intFromString(1, 2000).default(500),

    // Google Maps, as an alternative to the raster tiles above.
    //
    // Set a key here and the Warehouses screen draws a Google map instead of
    // a tile layer: vector rendering, and whatever style the operator built in
    // the Cloud console. **Google wins over MAP_TILE_URL when both are set**,
    // and that precedence is the useful way round - an operator moving from
    // OpenStreetMap to Google sets two variables and does not also have to
    // remember to clear two others.
    //
    // Google's tiles cannot be used as an XYZ raster layer, which is why this
    // is a second setting rather than another URL for the one above. There is
    // no public tile endpoint and their terms forbid reaching for one, so the
    // browser loads their JavaScript API instead. Both paths stay in the
    // product: an installation behind a firewall, or one whose operator will
    // not send warehouse coordinates to Google, still has the tile route and
    // still has the plain grid.
    //
    // THIS KEY REACHES THE BROWSER, and that is not a leak - the Maps
    // JavaScript API has no server side and every deployment's key is public
    // to anybody who opens the panel. What stops it being *used* elsewhere is
    // the restriction on the key itself, set in the Cloud console:
    //
    //   - Application restrictions: HTTP referrers, listing the panel's own
    //     origin. This is the one that matters. An unrestricted key can be
    //     lifted off the page and spent by anybody.
    //   - API restrictions: Maps JavaScript API only.
    //
    // A key restricted by referrer needs the browser to send one, so the
    // panel's own document must not carry `<meta name="referrer"
    // content="no-referrer">`. The API's own no-referrer policy is set on API
    // responses and does not affect it.
    MAP_GOOGLE_API_KEY: z.string().default(''),
    // The Cloud console's map ID, which is what carries the style.
    //
    // Required alongside the key rather than optional, and `superRefine`
    // below refuses to start without it. Two things depend on it: vector
    // rendering with a cloud-based style, which is the reason to choose
    // Google at all, and Advanced Markers, which is what the panel draws its
    // warehouses with. A key with no map ID would load a default-styled
    // raster map and then fail to place a single marker on it.
    MAP_GOOGLE_MAP_ID: z.string().default(''),

    // Address to coordinates, for the "find this address" button on a
    // warehouse. The mirror of GEOCODE_REVERSE_URL above and best-effort in
    // exactly the same way: unreachable, unconfigured or slow leaves the
    // coordinates alone for somebody to type, and never blocks the save.
    // {query} is the URL-encoded address. Shares GEOCODE_TIMEOUT_MS.
    GEOCODE_FORWARD_URL: z
      .string()
      .default('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q={query}'),

    // --- Storefront assistant ---
    //
    // The key stays here, server-side. The browser never sees it: the widget
    // talks to /api/v1/assistant/chat and this process talks to the provider.
    // Set no key at all and the whole feature is off — the config
    // endpoint reports it as unavailable and the storefront never mounts the
    // widget, so an unconfigured deployment shows no broken chat button.
    ASSISTANT_ENABLED: booleanFromString.default(true),
    // Leave blank to use whichever provider has a key configured. Set it
    // explicitly only when both keys are present and the choice matters.
    ASSISTANT_PROVIDER: z.enum(['', 'gemini', 'anthropic']).default(''),

    // Google AI Studio -> https://aistudio.google.com/apikey
    GEMINI_API_KEY: z.string().default(''),
    // Stable, generally available, and the cheapest tier that answers this
    // workload well. Reasoning is switched off in the provider — see
    // provider.gemini.ts for why that matters here.
    //
    // PINNED, NEVER AN ALIAS. `gemini-flash-latest` exists and is the wrong
    // choice: the model behind it changes without warning, and the thing that
    // changes with it is the tone and length of every reply a customer reads.
    // A model id is a deployment decision, so it moves when somebody moves it.
    //
    // This default was `gemini-2.5-flash` and had to change. That model now
    // answers 404 - "no longer available to new users" - so a fresh
    // deployment that never set `GEMINI_MODEL` got an assistant that failed on
    // every request, with nothing in the configuration to suggest why. A
    // default that points at a withdrawn model is worse than no default,
    // because it looks configured.
    //
    // Verified against the live models list for this deployment's key on
    // 2026-09-22. `npm run check:ai` in `scripts/` re-checks it.
    GEMINI_MODEL: z.string().min(1).default('gemini-3.8-flash'),

    // Anthropic Console -> https://console.anthropic.com/ -> API keys
    ANTHROPIC_API_KEY: z.string().default(''),
    ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5'),

    // Shared by whichever provider is in use.
    //
    // Deliberately small. This is a storefront answer, not an essay, and the
    // cap is the last line of defence on per-reply cost. The prompt asks for
    // about sixty words; 400 tokens is roughly three times that, so a normal
    // reply finishes well inside it and only a runaway one is cut off.
    ASSISTANT_MAX_TOKENS: intFromString(256, 8192).default(400),
    /** Messages one visitor may send in a single conversation before it resets. */
    ASSISTANT_MAX_TURNS: intFromString(2, 100).default(20),
    ASSISTANT_RATE_LIMIT_PER_5MIN: intFromString(1, 1000).default(20),

    /**
     * May somebody who is not signed in use AI Mode?
     *
     * **Off by default.** An anonymous caller spends the operator's AI
     * provider budget, and no rate limit makes that free: a limit bounds the
     * spend, it does not remove it. The default that costs an operator money
     * on a page anybody on the internet can open is the wrong default for
     * software somebody else pays to run — so this ships closed, and letting
     * guests in is a decision a deployment makes with its own bill in view.
     *
     * Set it to `true` where a buyer evaluating the catalogue should be able
     * to ask what is in it before opening an account — the same reasoning that
     * puts the sign-in wall at the cart rather than at the front door. AI Mode
     * handles both settings: with guests off it offers a way in where the
     * composer would be, rather than a composer that fails on send.
     *
     * What a guest can never do, whatever this is set to: read anybody else's
     * conversation, keep a history, or name a model, a system prompt or a
     * token budget. Ownership and the fixed parameters are enforced the same
     * way for everyone.
     */
    ASSISTANT_ALLOW_GUESTS: booleanFromString.default(false),

    /**
     * The chat allowance for a caller with no account, per IP per 5 minutes.
     *
     * Lower than the signed-in one on purpose. A customer is one identified
     * business whose spend the operator can attribute and, if it comes to it,
     * bill against an account; a guest is an address. It is not so low that a
     * procurement office behind one NAT address cannot try the assistant out.
     */
    ASSISTANT_GUEST_RATE_LIMIT_PER_5MIN: intFromString(1, 1000).default(10),

    /**
     * How many questions a visitor with no account may ask, in total.
     *
     * A DIFFERENT limit from the one above, and the difference is the whole
     * point of having both:
     *
     *   - `ASSISTANT_GUEST_RATE_LIMIT_PER_5MIN` is a tap. It bounds how fast
     *     an address can spend the operator's provider budget, and waiting
     *     five minutes opens it again. It is a defence against a script.
     *   - This is a TASTE. It bounds how much of the assistant somebody gets
     *     before they are asked to open an account, and waiting does not give
     *     them more. It is a product decision, not a defence.
     *
     * Five, because that is roughly the length of a real evaluation - what do
     * you sell, do you have it in 316, what is the lead time, can you ship to
     * Rotterdam - and it ends where somebody has learned enough to want an
     * account rather than before they have learned anything. An operator who
     * would rather be more or less generous moves the number; it is their
     * provider bill.
     *
     * Counted in VISITOR messages on the conversation, not in turns and not in
     * rows: an answer the model refused, or one cut off by a dropped
     * connection, still cost a question to ask and must still count. Only what
     * the visitor sent is counted, so a long answer is not two questions.
     *
     * Zero means no cap - guests get the rate limit and nothing else. It is
     * not the default, because a deployment that has turned guests on has
     * usually done so to let people try the thing rather than to host a free
     * AI endpoint.
     *
     * It applies ONLY to a guest. A signed-in customer is bounded by
     * `ASSISTANT_MAX_TURNS` per conversation and by their rate limit, exactly
     * as before, and starting a new conversation is always open to them.
     */
    ASSISTANT_GUEST_MESSAGE_LIMIT: intFromString(0, 1000).default(5),

    // --- Data protection (GDPR) ---
    //
    // Storage limitation (Art. 5(1)(e)) is a number, not an intention: personal
    // data is kept "no longer than is necessary", and the only way a running
    // system can honour that is to be told how long that is and to delete on
    // its own. Every window below is a maximum age in days, and 0 switches that
    // sweep off for deployments whose own retention schedule says otherwise.
    //
    // The defaults are deliberately conservative rather than minimal. Erasing
    // an audit trail or an order too eagerly breaks a different law - tax law
    // in most member states wants invoicing records for six to ten years - so
    // the sweeps here cover the categories that have no such obligation, and
    // the erasure path (see erasure.service.ts) is what deals with the rest by
    // pseudonymising instead of deleting.

    /// Abandoned carts. Nobody's tax authority wants a basket that was never
    /// bought, and it names a person and what they were interested in.
    RETENTION_ABANDONED_CART_DAYS: intFromString(0, 3650).default(90),

    /// Chat enquiries from the storefront widget: a stranger's name, mobile
    /// number, email and transcript, captured before any relationship exists.
    /// The shortest window here, because it is the weakest lawful basis.
    RETENTION_ASSISTANT_CONVERSATION_DAYS: intFromString(0, 3650).default(180),

    /// The audit trail. Two years covers a security investigation and an
    /// accountability question (Art. 5(2)) without keeping every read of every
    /// record for the life of the installation.
    RETENTION_AUDIT_LOG_DAYS: intFromString(0, 3650).default(730),

    /// Delivered notifications, with the rendered body still on them. Easy to
    /// overlook and worth the longest look: an order confirmation is the
    /// customer's name and delivery address written out in prose, so the
    /// outbox holds a second copy of data the order already holds properly.
    /// A year is generous for "did that email actually go out?".
    RETENTION_SENT_NOTIFICATION_DAYS: intFromString(0, 3650).default(365),

    /// Where an admin session was opened from, and the IP and user-agent that
    /// went with it. This is staff monitoring data and ages badly: it is
    /// useful for "was that sign-in me?" for a few weeks and is a liability
    /// after that, so it is scrubbed from the session row long before the row
    /// itself goes.
    RETENTION_SESSION_LOCATION_DAYS: intFromString(0, 3650).default(90),

    /// How long a fulfilled export bundle stays downloadable. Shorter than the
    /// admin report exports next door, because this file is every personal
    /// fact the system holds about one person in one archive.
    DATA_REQUEST_DOWNLOAD_TTL_HOURS: intFromString(1, 720).default(72),

    // --- Housekeeping ----------------------------------------------------
    //
    // The three windows above answer to a regulator. These answer to a disk.
    //
    // They are here rather than beside them because the question is a
    // different one: nothing below is kept because somebody has a right to it,
    // and nothing below is deleted because somebody has a right to have it
    // deleted. These are operational tables that grow with TRAFFIC rather than
    // with business volume, and every one of them had no sweep at all - the
    // job queue gains about twenty thousand rows a day from the maintenance
    // beat alone, the session table gains one row per refresh rotation, and
    // the rate-limit table takes a write on every single request. Left alone
    // they are the thing that slows an installation down six months in, with
    // nothing in the application to explain why.
    //
    // `0` switches a sweep off, the same as above. See
    // `infra/housekeeping.ts`.

    /// Finished background jobs - SUCCEEDED and DEAD. Long enough to answer
    /// "did last night's run happen, and what did it say?" and no longer: the
    /// work itself is recorded by whatever the job did, not by the queue row.
    /// Jobs still PENDING or RUNNING are never touched whatever this says.
    RETENTION_JOB_HISTORY_DAYS: intFromString(0, 3650).default(7),

    /// Verified provider webhooks, with up to 60 KB of raw payload each. Two
    /// years, matching the audit trail: this is the evidence behind a captured
    /// payment, so it outlives any chargeback window by a wide margin. The row
    /// is not the payment - the order and the transaction are - which is why
    /// it may eventually go at all.
    RETENTION_PAYMENT_EVENT_DAYS: intFromString(0, 3650).default(730),

    /// Session rows past their own expiry. A refresh ROTATES rather than
    /// updates, so a browser in daily use leaves a trail of revoked rows
    /// behind it; a month after one has expired there is nothing left to learn
    /// from it that the audit trail does not hold.
    RETENTION_EXPIRED_SESSION_DAYS: intFromString(0, 3650).default(30),

    // --- Demonstration catalogue ---------------------------------------
    //
    // A broad, plainly fictional catalogue - every department, every
    // sub-category - planted by `npm run seed:demo-catalog` so that a freshly
    // installed deployment can be reviewed, demonstrated and tested end to
    // end instead of presenting a search box with nothing behind it.
    //
    // Whether those products are VISIBLE to a shopper. Off does not delete
    // anything: the rows stay exactly where they are and every one of them
    // disappears from `publicProductWhere()`, which is the single filter every
    // public catalogue read goes through. That is the switch an operator
    // throws on the day they go live with their own range.
    //
    // ON in development and OFF in production, which is the only pair of
    // defaults that is safe in both directions. A developer who has just run
    // the seed should see the catalogue without configuring anything, and a
    // production deployment must never show a fictional product because
    // somebody restored a development database into it. An operator who
    // genuinely wants a demonstration storefront in production sets it to
    // true, deliberately.
    //
    // `process.env` directly, because this default has to be known while the
    // schema is being built and `env.NODE_ENV` does not exist until it has
    // been parsed. Anything other than a literal "production" is treated as
    // not production, which errs towards showing the catalogue on a machine
    // whose NODE_ENV is unset - the safe direction for a default that decides
    // whether a developer sees anything at all.
    ENABLE_DEMO_CATALOG: booleanFromString.default(process.env.NODE_ENV !== 'production'),

    /// How many product families the seed plants per sub-category.
    ///
    /// Three is the floor the coverage test asserts and the figure the
    /// blueprint registry is written to. Raising it does not invent products:
    /// a sub-category with four blueprints yields four and no more, so this is
    /// a ceiling for a quick run rather than a target to pad out to.
    DEMO_CATALOG_PRODUCT_COUNT: intFromString(1, 12).default(6),

    /// Unsplash access key, for resolving product photographs at seed time.
    ///
    /// Empty is a supported state and the ordinary one: the seed then draws on
    /// the verified image library the storefront already ships with, marks
    /// what it could not answer for review, and says so in its report. The key
    /// is read by the seed process only - it is never sent to a browser, never
    /// logged, and no runtime route reads it.
    UNSPLASH_ACCESS_KEY: z.string().default(''),

    // --- Logistics partner portal -------------------------------------
    //
    // Third-party carriers who collect from a warehouse and deliver to the
    // business that bought the goods.
    //
    // The master switch. OFF by default, and that default is the important
    // part: turning it on means this deployment is prepared to hand a
    // consignee's name, address and telephone number to another company, and
    // that should be a decision somebody made rather than a behaviour they
    // inherited by installing the software.
    //
    // Off means: the portal's routes answer FEATURE_DISABLED, no partner can
    // be created, no invitation can be sent, no carrier webhook is mounted and
    // no polling job is enqueued. Every existing order, seller and warehouse
    // flow is untouched either way.
    FEATURE_LOGISTICS_PORTAL: booleanFromString.default(false),

    /// How long a partner has to accept or reject an assignment, in hours.
    ///
    /// After this the offer lapses back to the pool and the operator is told.
    /// A commercial figure rather than a technical one - 4 hours is right for
    /// a same-day courier network and absurd for a weekly groupage run - which
    /// is exactly why it is a setting.
    LOGISTICS_ASSIGNMENT_RESPONSE_HOURS: intFromString(1, 720).default(24),

    /// How long an invitation to a partner user stays valid, in hours.
    ///
    /// Shorter than the 168 hours a customer invitation gets. A carrier being
    /// onboarded is in an active conversation with the operator, and a link
    /// that grants access to other companies' delivery addresses should not
    /// sit live in a mailbox for a week.
    LOGISTICS_INVITE_TTL_HOURS: intFromString(1, 720).default(48),

    /// How long a driver's device token is good for, in hours.
    ///
    /// The credential a phone sends location pings with. Short, and scoped to
    /// one trip: it authorises position ingestion for that trip and nothing
    /// else, so a token lifted off a handset cannot read a shipment. A shift
    /// is 12 hours in most fleets; the token is refreshed rather than
    /// lengthened.
    LOGISTICS_TRIP_TOKEN_TTL_HOURS: intFromString(1, 48).default(14),

    /// How often a driver's device should report, in seconds.
    ///
    /// Sent TO the phone rather than decided by it, so an operator can slow
    /// every device in the fleet at once and a battery-aware client can be
    /// told to. 60 seconds is a compromise between a usable map and a handset
    /// that lasts a shift.
    LOGISTICS_PING_INTERVAL_SECONDS: intFromString(10, 3600).default(60),

    /// How stale a device timestamp may be before a ping is refused, in
    /// minutes.
    ///
    /// Generous, because the whole point of the offline queue is that a van in
    /// a basement car park flushes an hour of positions when it surfaces.
    /// Beyond this the position is history rather than tracking and is
    /// refused, so a replayed batch cannot move a marker.
    LOGISTICS_PING_MAX_AGE_MINUTES: intFromString(1, 1440).default(120),

    /// The fastest a vehicle is believed to travel, in km/h.
    ///
    /// Two consecutive positions implying more than this are a bad fix, a
    /// spoofed location or a mis-scaled coordinate, and the ping is refused
    /// rather than drawn. 200 allows a motorway and a European high-speed
    /// train, and refuses a jet - which is what a phone reports when its GPS
    /// glitches.
    LOGISTICS_PING_MAX_SPEED_KMH: intFromString(10, 1200).default(200),

    /// How long raw driver positions are kept, in days.
    ///
    /// The single most sensitive personal data this feature collects: one
    /// employee's movements, minute by minute. Storage limitation (Art.
    /// 5(1)(e)) is a number rather than an intention, and 30 days is long
    /// enough to investigate a disputed delivery and short enough not to be a
    /// standing surveillance archive. 0 switches the sweep off for a
    /// deployment whose own retention schedule says otherwise.
    RETENTION_LOGISTICS_LOCATION_PING_DAYS: intFromString(0, 3650).default(30),

    /// Attempts at one carrier webhook before it is dead-lettered.
    ///
    /// A dead-lettered tracking event is a parcel whose customer is being told
    /// something out of date, so it is surfaced on the integrations screen
    /// rather than dropped.
    LOGISTICS_WEBHOOK_MAX_ATTEMPTS: intFromString(1, 20).default(6),

    /// Consecutive failures before a carrier integration is taken out of
    /// service, until a test passes. Without it, a carrier that has been down
    /// for a fortnight is called every half hour for a fortnight.
    LOGISTICS_CARRIER_FAILURE_THRESHOLD: intFromString(1, 100).default(5),

    /// Whether a document with no malware scan may be served.
    ///
    /// FALSE, and the direction matters. This deployment has no scanner
    /// configured out of the box, so every upload records SKIPPED rather than
    /// CLEAN - marking an unscanned file clean is the outcome the scan-state
    /// enum exists to make impossible. With this false a SKIPPED document is
    /// stored and refused on download until somebody wires a scanner or turns
    /// this on deliberately.
    LOGISTICS_ALLOW_UNSCANNED_DOCUMENTS: booleanFromString.default(false),

    /// How long a signed document link is good for, in seconds.
    ///
    /// Short. A Proof of Delivery is somebody's signature and a commercial
    /// invoice is a price list; a link that outlives the page it was rendered
    /// on is a link that ends up in a chat window.
    LOGISTICS_DOCUMENT_URL_TTL_SECONDS: intFromString(30, 3600).default(300),

    /// Whether a seller's unscanned certificate may be served.
    ///
    /// False by default. Production also requires ClamAV, so this switch is a
    /// development escape hatch only and must never make an unscanned file
    /// downloadable on a live installation.
    SELLER_ALLOW_UNSCANNED_DOCUMENTS: booleanFromString.default(false),

    // --- Rate limits ---
    RATE_LIMIT_GLOBAL_PER_MINUTE: intFromString(10, 100_000).default(300),
    RATE_LIMIT_LOGIN_PER_15MIN: intFromString(1, 1000).default(10),
    LOGIN_LOCKOUT_THRESHOLD: intFromString(3, 100).default(8),
    LOGIN_LOCKOUT_MINUTES: intFromString(1, 1440).default(15),
  })
  .superRefine((value, ctx) => {
    // AES-256-GCM needs exactly 32 bytes of key material.
    const keyBytes = Buffer.from(value.SECRETS_ENCRYPTION_KEY, 'base64');
    if (keyBytes.length !== 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SECRETS_ENCRYPTION_KEY'],
        message: `must be exactly 32 bytes base64-encoded for AES-256-GCM (got ${keyBytes.length}). Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      });
    }

    /*
     * A ceiling below the sliding window it is meant to cap.
     *
     * With SESSION_ABSOLUTE_TTL_SECONDS under REFRESH_TOKEN_TTL_SECONDS, every
     * family would be revoked by age before its own refresh token expired -
     * so the refresh setting would silently mean nothing and people would be
     * signed out on a schedule nobody configured. Caught at startup, where the
     * two numbers are side by side.
     */
    if (value.SESSION_ABSOLUTE_TTL_SECONDS <= value.REFRESH_TOKEN_TTL_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_ABSOLUTE_TTL_SECONDS'],
        message:
          `SESSION_ABSOLUTE_TTL_SECONDS (${String(value.SESSION_ABSOLUTE_TTL_SECONDS)}s) must be ` +
          `longer than REFRESH_TOKEN_TTL_SECONDS (${String(value.REFRESH_TOKEN_TTL_SECONDS)}s). ` +
          'The first is the ceiling on a whole sign-in; the second is how long one refresh ' +
          'token lives. A ceiling below it ends every session early and makes the refresh ' +
          'setting meaningless.',
      });
    }

    /*
     * The logistics portal, switched on with nowhere to send anybody.
     *
     * An invitation email carries an activation link, and the link is built
     * from LOGISTICS_WEB_PUBLIC_URL. With the feature on and the URL unset,
     * every carrier invited would receive a mail with a broken address in it -
     * and nobody would find out until a partner said so. Refused at startup,
     * where it is one line to fix.
     */
    /*
     * Direct mode without an allowlist is refused outright.
     *
     * TallyPrime's HTTP listener authenticates nobody. A deployment that let a
     * seller type any address would be an SSRF proxy with a business reason
     * attached, and one that let them type their own public address would be
     * inviting them to publish their ledger. The allowlist is what makes the
     * mode mean "inside the network the operator controls" rather than "any
     * host at all", so an empty one is a configuration mistake and not a
     * permissive default.
     */
    if (value.SELLER_ERP_ALLOW_DIRECT_MODE && value.SELLER_ERP_DIRECT_HOST_SUFFIXES.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SELLER_ERP_DIRECT_HOST_SUFFIXES'],
        message:
          'required when SELLER_ERP_ALLOW_DIRECT_MODE is on. TallyPrime’s HTTP interface has no ' +
          'authentication of any kind, so an unrestricted direct mode lets a seller point this ' +
          'server at an address of their choosing. List the hosts inside your own network, or ' +
          'leave direct mode off and use the Glovia Tally Bridge.',
      });
    }

    if (value.FEATURE_LOGISTICS_PORTAL) {
      if (value.LOGISTICS_WEB_PUBLIC_URL.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['LOGISTICS_WEB_PUBLIC_URL'],
          message:
            'required when FEATURE_LOGISTICS_PORTAL is on. It is where an invited partner user ' +
            'activation link points; without it every invitation email is undeliverable.',
        });
      } else {
        try {
          const parsed = new URL(value.LOGISTICS_WEB_PUBLIC_URL);
          if (parsed.protocol !== 'https:' && value.NODE_ENV === 'production') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['LOGISTICS_WEB_PUBLIC_URL'],
              message:
                'must be an https address in production - an activation link delivered over ' +
                'plain HTTP is readable by anybody on the path, and it sets a password.',
            });
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['LOGISTICS_WEB_PUBLIC_URL'],
            message: 'must be a full URL, including https://',
          });
        }
      }

      if (value.LOGISTICS_WEB_ORIGIN.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['LOGISTICS_WEB_ORIGIN'],
          message:
            'required when FEATURE_LOGISTICS_PORTAL is on. Without it the portal is not in the ' +
            'CORS allowlist and every request it makes is refused by the browser.',
        });
      }
    }

    if (value.QUEUE_DRIVER === 'redis' && value.REDIS_URL.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'required when QUEUE_DRIVER=redis',
      });
    }
    if (value.CACHE_DRIVER === 'redis' && value.REDIS_URL.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'required when CACHE_DRIVER=redis',
      });
    }

    if (value.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (value[key].length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'required when STORAGE_DRIVER=s3',
          });
        }
      }
    }

    if (value.EMAIL_DRIVER === 'smtp' && value.SMTP_HOST.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_HOST'],
        message: 'required when EMAIL_DRIVER=smtp',
      });
    }

    // A Google Maps key with no map ID beside it loads a map nobody styled
    // and then cannot place a marker on it - Advanced Markers need the ID.
    // Refused at startup, because the alternative is a Warehouses screen that
    // looks like it worked and shows no warehouses.
    if (value.MAP_GOOGLE_API_KEY.length > 0 && value.MAP_GOOGLE_MAP_ID.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAP_GOOGLE_MAP_ID'],
        message:
          'required when MAP_GOOGLE_API_KEY is set. Create one in the Google Cloud console under Map management (type: JavaScript, rendering: Vector) and attach a style to it.',
      });
    }

    // --- Scheduled-order settings that only make sense together -----------
    //
    // A reminder that arrives after the edit window has shut is worse than no
    // reminder: it tells the customer they can still change or skip the order,
    // links them to a screen that then refuses, and the first thing they
    // conclude is that the refusal is a bug. Caught at startup, because the
    // symptom appears days later in somebody else's inbox.
    if (value.SCHEDULE_REMINDER_LEAD_HOURS * 60 <= value.SCHEDULE_EDIT_CUTOFF_MINUTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCHEDULE_REMINDER_LEAD_HOURS'],
        message:
          `SCHEDULE_REMINDER_LEAD_HOURS (${String(value.SCHEDULE_REMINDER_LEAD_HOURS)}h) must be ` +
          `longer than SCHEDULE_EDIT_CUTOFF_MINUTES (${String(value.SCHEDULE_EDIT_CUTOFF_MINUTES)}m). ` +
          'Otherwise the reminder invites the customer to change an order that can no longer be changed.',
      });
    }

    // Auto-pay charges people who are not present. Without Stripe there is no
    // path that can do it, and a plan enrolled against nothing would sit ACTIVE
    // and never deliver.
    if (
      value.FEATURE_SUBSCRIPTION_AUTOPAY &&
      value.STRIPE_SECRET_KEY.length === 0 &&
      value.NODE_ENV === 'production'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FEATURE_SUBSCRIPTION_AUTOPAY'],
        message:
          'FEATURE_SUBSCRIPTION_AUTOPAY is on but no Stripe secret key is configured. ' +
          'Subscriptions would be created and then never charge. Connect Stripe, or turn the flag off.',
      });
    }

    // Verifying stock against an ERP that was never named cannot be done, and
    // silently not doing it would mean charging for stock nobody confirmed.
    if (
      value.ERP_VERIFY_STOCK_BEFORE_CHARGE &&
      value.ERP_ORDER_CONNECTION_NAME.length > 0 &&
      value.ERP_ORDER_PATH.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ERP_ORDER_PATH'],
        message: 'required when ERP_ORDER_CONNECTION_NAME is set',
      });
    }

    // Half a registered OAuth app is worse than none. With an id and no
    // secret, every buyer who presses "Connect monday.com" gets as far as
    // their own consent screen and then fails at token exchange, which looks
    // like a fault in their account rather than a gap in ours.
    if (
      (value.MONDAY_OAUTH_CLIENT_ID.length > 0) !==
      (value.MONDAY_OAUTH_CLIENT_SECRET.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MONDAY_OAUTH_CLIENT_SECRET'],
        message:
          'MONDAY_OAUTH_CLIENT_ID and MONDAY_OAUTH_CLIENT_SECRET must be set together. ' +
          'Set both to offer monday.com production connections, or neither to offer only ' +
          'the sandbox personal-token path.',
      });
    }

    // A redirect URI that is not a URL cannot be registered with anybody's ERP
    // and cannot be compared at token exchange, which is where the failure
    // would otherwise surface - long after the buyer has authorised.
    if (value.CUSTOMER_ERP_OAUTH_REDIRECT_URI.length > 0) {
      try {
        const parsed = new URL(value.CUSTOMER_ERP_OAUTH_REDIRECT_URI);
        if (parsed.protocol !== 'https:' && value.NODE_ENV === 'production') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CUSTOMER_ERP_OAUTH_REDIRECT_URI'],
            message: 'must be an https address in production - an authorisation code ' +
              'delivered over plain HTTP is readable by anybody on the path.',
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CUSTOMER_ERP_OAUTH_REDIRECT_URI'],
          message: 'must be a full URL, including https://',
        });
      }
    }

    // The one setting in this file that is a security control rather than a
    // preference, and the only one refused outright rather than warned about.
    //
    // ALLOW_PRIVATE_ERP_TARGETS lets a customer-supplied address resolve to a
    // private or loopback network. In development that is how somebody points a
    // connection at a mock ERP on localhost:9000. In production it is a way for
    // anybody who can save a connection to make this server fetch
    // http://169.254.169.254/latest/meta-data/iam/security-credentials/ and read
    // the instance's cloud credentials back out of a sync error message.
    //
    // There is no deployment where that is the intended behaviour, so this
    // refuses to start rather than logging a warning nobody reads.
    if (value.NODE_ENV === 'production' && value.ALLOW_PRIVATE_ERP_TARGETS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALLOW_PRIVATE_ERP_TARGETS'],
        message:
          'ALLOW_PRIVATE_ERP_TARGETS cannot be true in production. It permits a customer-supplied ' +
          'address to resolve to a loopback, link-local or private network, which makes the ' +
          'cloud metadata endpoint reachable from a form field. It exists for local development ' +
          'against a mock ERP and nothing else.',
      });
    }

    // Auto-pay with nothing that can charge. A customer would tick the consent
    // box, agree to a ceiling, and then have every scheduled delivery fail at
    // the moment of payment - having been told the opposite.
    if (
      value.FEATURE_CUSTOMER_AUTOPAY &&
      value.STRIPE_SECRET_KEY.length === 0 &&
      value.NODE_ENV === 'production'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FEATURE_CUSTOMER_AUTOPAY'],
        message:
          'FEATURE_CUSTOMER_AUTOPAY is on but no Stripe secret key is configured. Customers ' +
          'would be asked to consent to charges that could never be made. Connect Stripe, or ' +
          'turn the flag off.',
      });
    }

    // Auto-pay stores a card and charges it off-session, which needs the
    // SetupIntent path that FEATURE_SUBSCRIPTION_AUTOPAY gates. On without it,
    // a customer can consent to auto-pay and then find no way to add a card.
    if (value.FEATURE_CUSTOMER_AUTOPAY && !value.FEATURE_SUBSCRIPTION_AUTOPAY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FEATURE_CUSTOMER_AUTOPAY'],
        message:
          'FEATURE_CUSTOMER_AUTOPAY needs FEATURE_SUBSCRIPTION_AUTOPAY, which is what lets a ' +
          'customer save a card at all. Turn both on, or neither.',
      });
    }

    // --- Live-credential guard --------------------------------------------
    //
    // The single control that stands between a development machine and real
    // money. A live key moves actual funds from actual customers, so it may
    // only exist in a deployment that has declared itself production. Anywhere
    // else, the process refuses to start rather than starting and hoping
    // nobody triggers a payment.
    if (value.NODE_ENV !== 'production') {
      if (value.RAZORPAY_KEY_ID.startsWith('rzp_live_')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RAZORPAY_KEY_ID'],
          message:
            'refusing to start: this is a LIVE Razorpay key and NODE_ENV is not production. ' +
            'Live keys move real money. Use a rzp_test_ key for development.',
        });
      }

      if (value.STRIPE_SECRET_KEY.startsWith('sk_live_')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_SECRET_KEY'],
          message:
            'refusing to start: this is a LIVE Stripe key and NODE_ENV is not production. ' +
            'Live keys move real money. Use a sk_test_ key for development.',
        });
      }

      if (value.STRIPE_PUBLISHABLE_KEY.startsWith('pk_live_')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_PUBLISHABLE_KEY'],
          message:
            'refusing to start: this is a LIVE Stripe publishable key and NODE_ENV is not ' +
            'production. Use a pk_test_ key for development.',
        });
      }
    }

    // A publishable key from one environment paired with a secret key from the
    // other is the worst of the mismatches: the API handshake succeeds, the
    // browser opens a checkout against the other environment, and no payment
    // can ever be confirmed. Caught at boot, where it is one line to fix.
    if (value.STRIPE_PUBLISHABLE_KEY.length > 0 && value.STRIPE_SECRET_KEY.length > 0) {
      const publishableIsLive = value.STRIPE_PUBLISHABLE_KEY.startsWith('pk_live_');
      const secretIsLive =
        value.STRIPE_SECRET_KEY.startsWith('sk_live_') ||
        value.STRIPE_SECRET_KEY.startsWith('rk_live_');

      if (publishableIsLive !== secretIsLive) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_PUBLISHABLE_KEY'],
          message:
            'STRIPE_PUBLISHABLE_KEY and STRIPE_SECRET_KEY are from different Stripe ' +
            'environments. Pair pk_test_ with sk_test_, or pk_live_ with sk_live_.',
        });
      }
    }

    // Stripe cannot be the default gateway without a key pair to use.
    if (
      value.PAYMENT_DEFAULT_PROVIDER === 'stripe' &&
      value.STRIPE_SECRET_KEY.length > 0 &&
      value.STRIPE_PUBLISHABLE_KEY.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STRIPE_PUBLISHABLE_KEY'],
        message:
          'STRIPE_SECRET_KEY is set but STRIPE_PUBLISHABLE_KEY is empty. The browser needs ' +
          'the pk_ key to open a Stripe checkout.',
      });
    }

    // The mirror of the rule above: production must not run on test keys, or
    // customers appear to pay and no money is ever collected.
    if (value.NODE_ENV === 'production' && value.RAZORPAY_KEY_ID.startsWith('rzp_test_')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RAZORPAY_KEY_ID'],
        message:
          'this is a TEST Razorpay key and NODE_ENV is production. Test keys never collect money.',
      });
    }

    if (value.NODE_ENV === 'production' && value.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STRIPE_SECRET_KEY'],
        message:
          'this is a TEST Stripe key and NODE_ENV is production. Test keys never collect money.',
      });
    }

    /*
     * The mock-success door, and the two places it must never open.
     *
     * Production is the obvious one. The other is a live credential in any
     * environment: a staging box pointed at a live gateway is a place where
     * real money is at stake, whatever NODE_ENV says, and an order confirmed
     * there without a payment is an order somebody ships for free.
     *
     * Refused at boot rather than ignored at runtime. A flag that is silently
     * disregarded is worse than one that refuses: the operator goes on
     * believing it is set to something.
     */
    if (value.PAYMENT_MOCK_SUCCESS) {
      if (value.NODE_ENV === 'production') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PAYMENT_MOCK_SUCCESS'],
          message:
            'must be false in production. It confirms orders nobody has paid for.',
        });
      }

      const liveCredential = [
        value.RAZORPAY_KEY_ID,
        value.STRIPE_PUBLISHABLE_KEY,
        value.STRIPE_SECRET_KEY,
      ].some((key) => isLivePaymentKey(key));

      if (liveCredential) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PAYMENT_MOCK_SUCCESS'],
          message:
            'cannot be true while a LIVE payment key is configured. Mock payments ' +
            'confirm orders no money was taken for.',
        });
      }
    }
    // Production-only guards. These are the settings that look harmless in dev
    // and are outright dangerous once real customers and money are involved.
    if (value.NODE_ENV === 'production') {
      if (!value.FEATURE_ADMIN_MFA) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FEATURE_ADMIN_MFA'],
          message: 'must be true in production for every privileged staff session',
        });
      }
      if (!value.COOKIE_SECURE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['COOKIE_SECURE'],
          message: 'must be true in production',
        });
      }
      if (value.EMAIL_DRIVER === 'log') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_DRIVER'],
          message: 'the log driver does not deliver mail; configure smtp in production',
        });
      }
      if (value.STORAGE_DRIVER === 'local') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STORAGE_DRIVER'],
          message: 'local disk storage is not durable; configure s3 in production',
        });
      }
      if (value.MALWARE_SCANNER_DRIVER !== 'clamav') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MALWARE_SCANNER_DRIVER'],
          message: 'must be clamav in production so uploaded documents are scanned before storage',
        });
      }
      if (value.SELLER_ALLOW_UNSCANNED_DOCUMENTS || value.LOGISTICS_ALLOW_UNSCANNED_DOCUMENTS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SELLER_ALLOW_UNSCANNED_DOCUMENTS'],
          message: 'unscanned document downloads cannot be enabled in production',
        });
      }
      for (const key of [
        'SESSION_COOKIE_SECRET',
        'ACCESS_TOKEN_SECRET',
        'REFRESH_TOKEN_SECRET',
      ] as const) {
        if (value[key].startsWith('replace-with')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'still holds the .env.example placeholder',
          });
        }
      }

      /*
       * One secret doing four jobs.
       *
       * The four keys below sign and encrypt different things - the cookie
       * signature, the access token, the refresh token and the credential
       * vault - and the whole reason they are four settings is that a
       * compromise of one must not be a compromise of the others. A
       * deployment that pastes the same generated string into all of them
       * gets none of that, and nothing about the running system says so: it
       * boots, it works, and the separation exists only in the names.
       *
       * Checked in production only. A developer sharing one string across a
       * throwaway `.env` is not interesting, and refusing it would add a
       * setup step for no gain.
       */
      const purposeKeys = [
        'SESSION_COOKIE_SECRET',
        'ACCESS_TOKEN_SECRET',
        'REFRESH_TOKEN_SECRET',
        'SECRETS_ENCRYPTION_KEY',
      ] as const;

      for (let i = 0; i < purposeKeys.length; i += 1) {
        for (let j = i + 1; j < purposeKeys.length; j += 1) {
          const first = purposeKeys[i];
          const second = purposeKeys[j];
          if (first === undefined || second === undefined) continue;
          if (value[first].length > 0 && value[first] === value[second]) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [second],
              message:
                `${second} is the same string as ${first}. Each of these protects a different ` +
                'thing and they must not be shared: one leaked value would otherwise forge ' +
                'sessions, mint tokens and decrypt every stored integration credential at ' +
                'once. Generate a separate value for each.',
            });
          }
        }
      }

      /*
       * SameSite=None without Secure is a cookie the browser throws away, and
       * SameSite=None at all means the session cookie is attached to requests
       * from any site. The double-submit CSRF token is still there, but this
       * removes the browser-level layer underneath it, so it is refused
       * outright rather than warned about.
       *
       * A deployment that genuinely needs it - the storefront and the API on
       * unrelated registrable domains - should proxy the API under the site's
       * own origin instead, which is what every shipped deployment does.
       */
      if (value.COOKIE_SAME_SITE === 'none') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['COOKIE_SAME_SITE'],
          message:
            'COOKIE_SAME_SITE=none cannot be used in production: it attaches the session cookie ' +
            'to cross-site requests and removes the browser-level CSRF protection underneath ' +
            'the double-submit token. Serve the API under the same registrable domain as the ' +
            'site - the shipped nginx and Netlify configurations both proxy /api/v1 - and ' +
            'leave this at lax.',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Check a candidate environment without starting anything.
 *
 * `loadEnv` below reads `process.env` and calls `process.exit(1)` when it does
 * not like what it finds, which is exactly right for a server and impossible
 * to test: importing this module a second time with a different environment
 * would take the test runner down with it.
 *
 * So the rules live behind this, which returns the verdict instead of acting
 * on it. `tests/unit/production-config.test.ts` uses it to prove that a
 * production configuration with insecure cookies, a shared secret, a test
 * payment key or the malware scanner switched off is actually refused -
 * rather than trusting that the code reads as though it would be.
 *
 * Returns the list of `PATH: message` strings, empty when the configuration is
 * acceptable.
 */
export function validationIssuesFor(candidate: Record<string, string | undefined>): string[] {
  const parsed = envSchema.safeParse(candidate);
  if (parsed.success) return [];
  return parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
}

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    // Deliberately process.stderr rather than the logger: the logger itself
    // depends on this module, so it does not exist yet at this point.
    process.stderr.write(
      `\nInvalid environment configuration:\n${lines.join('\n')}\n\n` +
        `Copy .env.example to .env and fill the required values.\n\n`,
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

/** Exact CORS allowlist. Admin and customer origins, no wildcards. */
export const allowedOrigins: readonly string[] = Object.freeze([
  ...env.ADMIN_WEB_ORIGIN,
  ...env.CUSTOMER_WEB_ORIGIN,
  ...env.LOGISTICS_WEB_ORIGIN,
]);

/** Decoded AES-256-GCM key. Validated to 32 bytes above. */
export const secretsEncryptionKey: Buffer = Buffer.from(env.SECRETS_ENCRYPTION_KEY, 'base64');
