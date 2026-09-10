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

    // How far the Warehouses screen says a warehouse delivers.
    //
    // A setting rather than a constant because it is a commercial promise, not
    // a technical limit: 100 km is what a van does in an afternoon in the
    // Benelux and nothing like the right number for a distributor covering
    // Rajasthan. The panel asks for this radius by default and the endpoint
    // accepts any value up to its own ceiling, so an operator can also try a
    // different one without changing this.
    //
    // Nothing about it is hard-coded in the frontend. The browser is told the
    // radius it should ask for by /config, the same way it is told everything
    // else it must not assume.
    DELIVERY_COVERAGE_RADIUS_KM: intFromString(1, 1000).default(100),

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

    /**
     * May somebody who is not signed in use AI Mode?
     *
     * On by default, because a buyer evaluating this catalogue should be able
     * to ask what is in it before opening an account — the same reasoning that
     * puts the sign-in wall at the cart rather than the front door.
     *
     * Understand what it costs before leaving it on. An anonymous caller
     * spends the operator's AI provider budget, and no rate limit makes that
     * free: it bounds the spend, it does not remove it. A deployment that
     * would rather pay only for its own customers sets this to `false`, and
     * AI Mode then offers a guest a way in instead of a composer — exactly as
     * it did before guests were let in.
     *
     * What a guest can never do, whatever this is set to: read anybody else's
     * conversation, keep a history, or name a model, a system prompt or a
     * token budget. Ownership and the fixed parameters are enforced the same
     * way for everyone.
     */
    ASSISTANT_ALLOW_GUESTS: booleanFromString.default(true),

    /**
     * The chat allowance for a caller with no account, per IP per 5 minutes.
     *
     * Lower than the signed-in one on purpose. A customer is one identified
     * business whose spend the operator can attribute and, if it comes to it,
     * bill against an account; a guest is an address. It is not so low that a
     * procurement office behind one NAT address cannot try the assistant out.
     */
    ASSISTANT_GUEST_RATE_LIMIT_PER_5MIN: intFromString(1, 1000).default(10),

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
