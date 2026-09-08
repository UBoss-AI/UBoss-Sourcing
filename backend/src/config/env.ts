/**
 * Environment loading and validation.
 *
 * The process refuses to boot on a missing or malformed value rather than
 * failing later inside a payment or migration path. Nothing in the codebase
 * reads `process.env` directly - everything imports `env` from here.
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

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

const envSchema = z
  .object({
    // --- Runtime ---
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: intFromString(1, 65535).default(4000),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    API_PUBLIC_URL: z.string().url(),

    // --- Frontend origins ---
    ADMIN_WEB_ORIGIN: originList,
    CUSTOMER_WEB_ORIGIN: originList,
    CUSTOMER_WEB_PUBLIC_URL: z.string().url(),
    ADMIN_WEB_PUBLIC_URL: z.string().url(),

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
    ACCESS_TOKEN_TTL_SECONDS: intFromString(60, 86_400).default(900),
    REFRESH_TOKEN_TTL_SECONDS: intFromString(3600, 31_536_000).default(2_592_000),
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
    STORAGE_PUBLIC_BASE_URL: z.string().url(),
    S3_ENDPOINT: z.string().default(''),
    S3_REGION: z.string().default(''),
    S3_BUCKET: z.string().default(''),
    S3_ACCESS_KEY_ID: z.string().default(''),
    S3_SECRET_ACCESS_KEY: z.string().default(''),
    S3_FORCE_PATH_STYLE: booleanFromString.default(true),
    UPLOAD_MAX_BYTES: intFromString(1024, 104_857_600).default(5_242_880),

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

    // --- Admin sign-in location ---
    //
    // On by default: the console asks the browser where the device is at
    // sign-in and stays closed until it is told. Two things a deployment has to
    // know before leaving it on.
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
    FEATURE_ADMIN_LOGIN_LOCATION: booleanFromString.default(true),
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
    MAP_TILE_URL: z.string().default(''),
    // Rendered in the corner of the map, as every tile licence requires. Kept
    // as free text rather than a lookup table of known providers: the operator
    // knows what their provider asks for, and this software cannot.
    MAP_TILE_ATTRIBUTION: z.string().default(''),

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
    // Stable, generally available, 1M-token input window, and the cheapest
    // tier that answers this workload well. Reasoning is switched off in the
    // provider — see provider.gemini.ts for why that matters here.
    GEMINI_MODEL: z.string().min(1).default('gemini-2.5-flash'),

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

    // Production-only guards. These are the settings that look harmless in dev
    // and are outright dangerous once real customers and money are involved.
    if (value.NODE_ENV === 'production') {
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
    }
  });

export type Env = z.infer<typeof envSchema>;

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
]);

/** Decoded AES-256-GCM key. Validated to 32 bytes above. */
export const secretsEncryptionKey: Buffer = Buffer.from(env.SECRETS_ENCRYPTION_KEY, 'base64');
