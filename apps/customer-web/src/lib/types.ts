/**
 * API response shapes for the storefront.
 *
 * Hand-written from the backend's routes rather than generated, because the
 * generated OpenAPI for this API describes paths and methods exactly but types
 * most response bodies as `Record<string, unknown>`.
 *
 * The rule when editing: money is always `Money`, never a number. If a field
 * here is typed `number` and it is an amount, that is a bug — a paisa-precise
 * total can exceed `2^53`, which is why it crosses the wire as a string.
 */
import type { Money } from './format';
import type { BuyablePackaging, LinePackaging } from './bulk-packaging';

export type { Money };

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Storefront configuration
// ---------------------------------------------------------------------------

export interface StorefrontConfig {
  /**
   * The seller whose shop front this is, on a per-seller subdomain.
   *
   * Absent on the operator's own domain, and on every deployment that has no
   * seller subdomains configured — which is most of them. When it is present
   * the `business` block above already carries the seller's name and contact
   * details, so nothing needs to choose between two sources; this is here for
   * the few places that have to say something different because a seller is
   * selling, rather than merely print a name.
   */
  seller?: {
    id: string;
    slug: string;
    displayName: string;
    legalName: string;
    description: string | null;
  };
  business: {
    displayName: string;
    /** The registered name behind the trading name. Only on a seller's shop. */
    legalName?: string;
    supportEmail: string | null;
    supportPhone: string | null;
    logo: { url: string; altText: string | null } | null;
    currency: string;
    timezone: string;
    policyLinks: Record<string, string> | null;
  };
  /**
   * The markets this store quotes in.
   *
   * Public, because a first-time visitor is asked where they are before the
   * storefront can price anything, and that question has to render before
   * anybody signs in.
   */
  localisation: {
    currencies: CurrencyOption[];
    countries: CountryOption[];
    baseCurrency: string;
  };
  features: {
    selfRegistration: boolean;
    /**
     * Whether a confirmed sign-up still waits for a member of staff before it
     * can order. Said on the sign-up form itself, not only afterwards -
     * somebody who needs to order today should find that out before typing.
     *
     * Optional because a config response cached from before this field existed
     * would otherwise be read as `false`, which is the reassuring answer and
     * the wrong one.
     */
    selfRegistrationRequiresApproval?: boolean;
    recurringOrders: boolean;
    /** Whether this deployment has an AI provider configured, and so AI Mode. */
    assistant: boolean;
    /**
     * Whether the camera button on the search bar can do anything.
     *
     * Today it tracks `assistant` exactly — image search is a vision call on
     * the same provider — but it travels as its own field so the storefront
     * never infers one capability from another, and so a deployment that later
     * gets a dedicated similarity index can turn the camera on without an AI
     * chat key.
     *
     * Optional because a config response cached from before this field existed
     * would otherwise be read as `false`, which is the safe answer either way.
     */
    imageSearch?: boolean;
  };

  /**
   * The two numbers the storefront has to draw a calendar and a warehouse
   * list from, rather than bake into the bundle.
   *
   * Both are deployment settings, and that is the whole point of publishing
   * them: a figure compiled into JavaScript is a figure the operator who
   * bought this software cannot change. See the `fulfilment` block in
   * `settings.service.ts` for the server's side of the same contract.
   *
   * Optional as a whole, because a config response cached from before the
   * block existed legitimately lacks it. Every reader supplies its own
   * fallback rather than treating absence as zero - a notice period read as
   * zero would offer tomorrow, which is the one wrong answer.
   */
  fulfilment?: {
    /** Days of notice the first delivery of a schedule needs. */
    scheduleMinNoticeDays: number;
    /** How long a warehouse option stays an offer, so checkout can re-ask first. */
    fulfilmentQuoteTtlSeconds: number;
  };

  /**
   * The selling unit. One carton, holding this many pieces.
   *
   * Every price a shopper sees is the price of one carton, worked out from the
   * catalogue's piece price and this number, so the storefront cannot print a
   * price before it has read this. It is the operator's setting rather than a
   * constant in the bundle, for the same reason the currency is.
   *
   * Optional because a config response cached from before the block existed
   * legitimately lacks it. Read it through `usePiecesPerCarton`, which
   * supplies the documented fallback rather than treating absence as zero.
   */
  ordering?: {
    piecesPerCarton: number;
  };

  /**
   * What the chat widget has to say about itself before anyone types.
   *
   * AI Act Art. 50(1) obliges the deployer to tell a person they are
   * interacting with an AI system. The vendor is named because that vendor
   * receives whatever the visitor types, which puts them in the privacy
   * notice under GDPR Art. 13(1)(e) - and a notice saying "a third-party AI
   * provider" names nobody.
   */
  assistant: {
    available: boolean;
    isAi: boolean;
    model: string | null;
    vendor: { name: string; country: string } | null;
    /**
     * Whether a visitor with no account may ask anything.
     *
     * `ASSISTANT_ALLOW_GUESTS` on the API, and it defaults to off. Known before
     * the page draws, so a guest is offered the way in where the composer would
     * have been rather than discovering it by typing a question and being
     * refused.
     */
    allowsGuests: boolean;
  };
}

export interface CurrencyOption {
  code: string;
  name: string;
  symbol: string;
  /** Minor units per major unit: 2 for INR/USD, 0 for JPY/KRW. */
  exponent: number;
  isBase: boolean;
  /**
   * Whether the catalogue actually sells anything in it. Staff can activate a
   * currency before pricing anything in it; offering that one here would just
   * hand the shopper an empty shop.
   *
   * Optional because a config response cached from before this field existed
   * legitimately lacks it; absent is treated as "offer it" rather than hiding
   * every currency at once.
   */
  hasProducts?: boolean;
}

export interface CountryOption {
  code: string;
  name: string;
  /** What a shopper from here is quoted in unless they choose otherwise. */
  currencyCode: string;
  phonePrefix: string | null;
}

/** The shopper's saved answer to "where are you?". Null until they answer. */
export interface Locale {
  country: string;
  currency: string;
  /** What the browser's geolocation resolved to, when it was allowed. */
  detectedCountry: string | null;
  /** True when geolocation disagreed with the stated country. */
  detectedMismatch: boolean;
  chosenAt: string | null;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  depth: number;
  sortOrder: number;
  isActive: boolean;
  /** Products filed directly in this category, and nothing else. */
  productCount: number;
  /** Products in this category and in every category beneath it. */
  totalProductCount: number;
  children: CategoryNode[];
}

export interface ProductImage {
  url: string;
  altText: string | null;
  width?: number;
  height?: number;
  isPrimary?: boolean;
}

/**
 * Purchasing rules.
 *
 * Shown before Add to Cart, not after. A customer who discovers a minimum of
 * 10 only when the cart rejects them has been wasted twice — the rules are
 * part of the product, so they belong on the product.
 */
export interface PurchaseRules {
  minOrderQty: number;
  maxOrderQty: number | null;
  qtyIncrement: number;
  isRecurringEligible: boolean;
}

/**
 * Why a price is approximate, when it is.
 *
 * Only ever sent for a figure the shop WORKED OUT from another currency, so
 * the presence of this object is itself the signal.  is spelled
 * out anyway rather than implied, because a client reading the object should
 * not have to infer the one thing that matters about it.
 */
export interface PriceConversion {
  approximate: true;
  /** The currency the real, typed figure lives in. */
  baseCurrency: string;
  /** The rate used, as an exact decimal string. Never a number. */
  rate: string;
  /** When the rate list was published, ISO-8601. Not when it was fetched. */
  rateAsOf: string;
  provider: string;
}

export interface ProductVariant {
  id: string;
  sku: string;
  name: string;
  options: Record<string, string>;
  price: Money | null;
  /** This size's own "was" price, quoted through the same destination. */
  compareAtPrice?: Money | null;
  isActive?: boolean;
  availableQty?: number | null;

  /**
   * Whether this one can be had right now. Never how many there are.
   *
   * A boolean, deliberately: this storefront does not publish warehouse
   * figures. Null means the question has no answer — an untracked product, or
   * a listing read that did not look stock up — and the selector treats that
   * as purchasable, because stock is confirmed when the item goes in the
   * basket.
   */
  isInStock?: boolean | null;
  /** GPSR Art. 19(c), per sellable SKU. Two sizes are two barcodes. */
  gtin?: string | null;
  modelIdentifier?: string | null;

  /**
   * This size's own terms of trade, or null where the product's apply.
   *
   * Null is not missing data. It means "whatever the product says", which is
   * what almost every variant says, and the server resolves it the same way on
   * every cart mutation — so honouring it here is a courtesy to the shopper
   * rather than a rule the client gets to decide.
   */
  minOrderQty?: number | null;
  qtyIncrement?: number | null;
  maxOrderQty?: number | null;
  leadTimeDays?: number | null;

  /**
   * What is in one purchasable unit.
   *
   * `multipackCount` is how many identical units are supplied together — the
   * 10 in "Pack of 10". It is NOT how many the shopper wants; that is the
   * quantity control, and the page states the two separately so that "3 of a
   * Pack of 10" cannot be read as three packets.
   */
  multipackCount?: number | null;
  /** A decimal string with its unit beside it, never a number. */
  netContentValue?: string | null;
  netContentUnit?: string | null;
  /** What a unit price is quoted against — "per 1 kg", "per 100 g". */
  unitPricingBaseValue?: string | null;
  unitPricingBaseUnit?: string | null;
  /** The manufacturer's own carton, in their words. Displayed, never parsed. */
  manufacturerPackLabel?: string | null;

  /** This size's photographs. Empty means "show the product's". */
  images?: ProductImage[];

  /**
   * This size's own packing. Present on the detail read, absent on a listing —
   * a grid of two dozen products does not need thirty packing rows each.
   */
  packaging?: ProductPackaging | null;
}

/**
 * One dimension a product can be chosen along, as the server defines it.
 *
 * Served once per session from `/catalog/variant-axes` rather than repeated on
 * every product, and defined in exactly one place — the 112 subcategory
 * templates in `backend/src/domain/variants/`. The storefront holds no list of
 * its own, which is what stops a filter and a selector disagreeing about what
 * "Size" means.
 */
export interface VariantAxisDefinition {
  key: string;
  label: string;
  input: 'TEXT_SELECT' | 'NUMERIC' | 'MEASUREMENT' | 'COLOUR' | 'BOOLEAN' | 'PACK_COUNT';
  display:
    | 'CHIPS'
    | 'SIZE_BUTTONS'
    | 'SWATCHES'
    | 'IMAGE_SWATCHES'
    | 'DROPDOWN'
    | 'MEASUREMENT'
    | 'PACK'
    | 'SPEC_TABLE';
  /** How the values are put in order. Alphabetical puts L before M. */
  sort: 'NUMERIC' | 'APPAREL' | 'GIVEN' | 'ALPHA';
  units: string[] | null;
  /**
   * Axes that must be answered first.
   *
   * Size depends on size system: an 8 is three different shoes in UK, EU and
   * US, and offering the number first offers a measurement with no unit.
   */
  dependsOn: string[];
  inTitle: boolean;
}

/** One box, as the catalogue knows it. */
export interface PackDimension {
  kind: 'PRIMARY_PACK' | 'INNER_BOX' | 'OUTER_CARTON';
  label: string;
  /** "460 × 350 × 210 mm", or the raw text where nothing could be read. */
  value: string;
  /**
   * False when the source never stated millimetres or inches.
   *
   * Shown as a caveat rather than hidden: a buyer sizing a shelf needs to know
   * that the number has no unit on it, and quietly assuming one would be a
   * twenty-five-fold error on a measurement given in inches.
   */
  hasUnit: boolean;
}

/**
 * How many are in a box, and how many boxes in a carton.
 *
 * Every figure is nullable because a supplier sheet often gives a carton total
 * and nothing else. Nothing here is ever derived in the browser — the server
 * does the arithmetic, and a missing figure stays missing.
 */
/**
 * What the supplier's sheet said about the product, minus every quantity.
 *
 * No piece counts, on purpose: the shop sells one carton of
 * `config.ordering.piecesPerCarton` pieces, and the supplier's own "2,000 to a
 * carton" printed on the same page would be a second answer to the only
 * question that decides what a buyer pays. The server stopped sending them —
 * see `packaging.service.ts`.
 */
export interface ProductPackaging {
  /** What it is packed as — "Blister", "Pouch". Never a quantity. */
  packingType: string | null;
  dimensions: PackDimension[];
}

/**
 * Whether this can be bought, and what to say instead when it cannot.
 *
 * Two separate reasons, because the customer has to do two different things. A
 * price on request is an invitation to get in touch; an unavailable product is
 * a wait. `canAddToCart` is the server's own single answer, so the storefront
 * never reaches its own conclusion from the two flags.
 */
export interface ProductPurchasability {
  isPriceOnRequest: boolean;
  isOrderable: boolean;
  unavailabilityReason: string | null;
  canAddToCart: boolean;
}

/**
 * What this product's price is a price FOR.
 *
 * `price` on a product is, and always has been, the price of one PIECE. This
 * says what to multiply it by before printing it, and what to call the result.
 * The operator's own products are cartons; a product a third-party seller
 * described is a piece, and its factor is 1.
 *
 * Decided by the SERVER from product ownership, on the same code path that
 * prices the basket - never worked out in the browser. A storefront that
 * derived it would eventually derive it differently from the cart, and the
 * shopper would be quoted one figure and charged another.
 */
export interface ProductSellUnit {
  unit: 'PIECE' | 'INNER_PACK' | 'OUTER_CARTON';
  piecesPerUnit: number;
  /** In sell units. What the quantity control must not go below. */
  minimumOrderQuantity: number;
  /** In sell units. What the quantity control must step by. */
  orderIncrement: number;
  maximumOrderQuantity: number | null;
  isPricedPerSellUnit: boolean;
}

export interface TaxInfo {
  code: string;
  name: string;
  /**
   * The rate that produced the price beside it — the destination member
   * state's, where one applies, and the tax class's own flat percentage
   * otherwise. Not a figure to recompute a price from: the server has already
   * applied it.
   */
  ratePercent: string;
  inclusive: boolean;
  /** ISO country whose rate was applied, or null where none was. */
  country: string | null;
  /** Why: DOMESTIC, INTRA_EU_B2C, EXPORT, INTRA_EU_REVERSE_CHARGE, FLAT_RATE. */
  treatment: string;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  sku: string;
  shortDescription: string | null;
  description: string | null;
  /** Sanitised server-side against an allowlist. Never rendered raw here. */
  descriptionHtml: string | null;
  price: Money;
  compareAtPrice: Money | null;
  /**
   * Present only when this figure was CONVERTED rather than typed for this
   * currency, and always `approximate: true` when it is.
   *
   * Null is the ordinary case and means a real price somebody entered for
   * this market. The storefront captions the other case wherever it shows the
   * number, because a converted figure is a conversion of a commitment made
   * in another currency at a reference rate that moves daily — and presenting
   * the two identically leaves the buyer to discover the difference on their
   * statement.
   */
  priceConversion?: PriceConversion | null;
  tax: TaxInfo;
  purchaseRules: PurchaseRules;
  category: { id: string; name: string; slug: string } | null;
  isStockTracked: boolean;
  hasVariants: boolean;

  /**
   * Whether the product itself can be had now. Never how many there are.
   *
   * The answer for a product sold as a single item, and the fallback for one
   * whose options are listed the old way. Null means the question has no
   * answer, and null is purchasable: stock is confirmed when the item goes in
   * the basket, which is what actually happens.
   */
  isInStock?: boolean | null;

  /**
   * The dimensions this product is chosen along, as axis keys.
   *
   * Empty is the ordinary case, and it means the page shows the option list
   * it has always shown: one row per variant, several selectable at once,
   * which is how a hospital buys three sizes of syringe in one go. A
   * non-empty list turns on the narrowing selector instead — colour, then
   * size, with the combinations nobody stocks disabled.
   *
   * The keys only. The labels and units come from /catalog/variant-axes.
   */
  variantAxisKeys?: string[];

  /**
   * Which of the catalogue templates this product's shelf uses.
   *
   * The key the axis definitions are looked up under. Null for a category
   * with no template, which is the same thing an empty variantAxisKeys says.
   */
  variantTemplateSlug?: string | null;
  publishedAt: string | null;
  primaryImage: ProductImage | null;
  images: ProductImage[];
  attributes: { name: string; value: string }[];
  variants: ProductVariant[];
  /**
   * GPSR Art. 19 information, when the catalogue carries it.
   *
   * Present on every product read, list and detail alike, because the article
   * is about what a buyer can see BEFORE they buy. Every field is nullable: a
   * catalogue outside the EU has no reason to fill any of it in, and the page
   * renders nothing where there is nothing rather than an empty heading.
   */
  safety?: ProductSafety | null;
  /**
   * MDR device identification, when the product is one.
   *
   * Null for everything else, which is most of a catalogue. The storefront
   * renders nothing rather than an empty heading — "a device with no
   * certification" is a far worse claim than silence.
   */
  device?: ProductDevice | null;
  availability?: {
    inStock: boolean;
    availableQty: number | null;
  } | null;
  /**
   * Absent on a response from an older server, and treated as "buyable" when
   * it is — which is what every product was before this existed.
   */
  purchasability?: ProductPurchasability | null;
  /** The product-level packing row. Null where none was recorded. */
  packaging?: ProductPackaging | null;
  /**
   * What `price` above is a price for, and how the quantity control may move.
   *
   * Optional so a response cached from before it existed still renders.
   * `sellUnitOf()` supplies the operator's carton in that case, which is what
   * every such response can only have been - see the note there.
   */
  sellUnit?: ProductSellUnit | null;
}

/** One company named on a listing under Union product law. */
export interface EconomicOperator {
  legalName: string;
  tradeName: string | null;
  address: {
    line1?: string;
    line2?: string | null;
    city?: string;
    region?: string | null;
    postalCode?: string | null;
  } | null;
  countryCode: string;
  /** Art. 19(a) calls this the "electronic address". */
  email: string;
  phone: string | null;
  website: string | null;
}

export interface ProductSafety {
  /** Follows the reader's language, falling back to the base copy. */
  warnings: string | null;
  instructions: string | null;
  gtin: string | null;
  modelIdentifier: string | null;
  manufacturer: EconomicOperator | null;
  /** Required when the manufacturer is established outside the Union. */
  euResponsiblePerson: EconomicOperator | null;
}

/** Risk class under Annex VIII. Class I is subdivided because the
 *  subdivision decides whether a notified body is involved at all. */
export type DeviceClass =
  | 'CLASS_I'
  | 'CLASS_I_STERILE'
  | 'CLASS_I_MEASURING'
  | 'CLASS_I_REUSABLE_SURGICAL'
  | 'CLASS_IIA'
  | 'CLASS_IIB'
  | 'CLASS_III';

export interface ProductDevice {
  deviceClass: DeviceClass;
  /**
   * Two identifiers doing two jobs. The Basic UDI-DI names the device group a
   * declaration of conformity is filed against; the UDI-DI names this
   * packaging configuration and is what appears on the label.
   */
  basicUdiDi: string | null;
  udiDi: string | null;
  /** The four digits beside the CE mark. Null for a self-certified Class I. */
  notifiedBodyNumber: string | null;
  declarationOfConformityUrl: string | null;
  /** Follows the reader's language, like the safety warnings. */
  intendedPurpose: string | null;
  isSterile: boolean;
  isSingleUse: boolean;
  hasMeasuringFunction: boolean;
  containsBiologicalMaterial: boolean;
  /** The manufacturer's Eudamed Single Registration Number, MDR Art. 31. */
  manufacturerSrn: string | null;
}

export interface ProductListResponse {
  products: Product[];
  pagination: Pagination;
  /** The currency every price in this response is quoted in. */
  currency: string;
  /** The destination every price in it was quoted for. Null when none was sent. */
  country: string | null;
}

/**
 * What the catalogue can be filtered by, for one listing.
 *
 * Which attributes appear is the administrator's decision — an attribute is a
 * facet only when it is marked filterable — so the filter panel asks rather
 * than hard-coding a list that would be wrong for every other business.
 *
 * The counts are taken with the other filters applied, so a value that would
 * return nothing is still shown with its real count rather than hidden: a
 * facet that disappears as soon as you use it is worse than one that says 0.
 */
export interface CatalogFilterFacets {
  currency: string;
  country: string | null;
  /**
   * What the catalogue holds, ignoring the price boxes. Null when empty.
   *
   * Quoted for the destination, like the grid beside it — the same catalogue
   * reads 100–500 in one member state and 104–520 in another, and a range that
   * did not move with the prices would bound the boxes wrongly.
   */
  priceRange: { min: Money | null; max: Money | null };
  attributes: { name: string; values: { value: string; count: number }[] }[];
}

export interface ProductDetailResponse {
  product: Product;
  currency: string;
  country: string | null;
  /**
   * Why the price is what it is, in a sentence — which country's VAT applies
   * and on what basis. Worth showing when the shopper has just changed market
   * and the number moved.
   */
  taxNote: string;
  /**
   * Currencies this product IS sold in, when it is not sold in the requested
   * one. Lets the page offer a switch instead of just saying "unavailable".
   */
  soldInCurrencies: string[];
  /**
   * The packages this seller will sell this in — carton, pallet, container.
   *
   * On the DETAIL response only. A grid card has no room for "2 UK pallets ×
   * 50 cartons × 24 units" and draws forty of them, so the server does not pay
   * forty queries for a sentence nobody can read at that size.
   *
   * EMPTY is the ordinary answer and will be for most of the catalogue for a
   * long time. An empty array is what makes the page draw its plain quantity
   * box with no packaging controls at all, so a response cached from before
   * this field existed behaves exactly as it did.
   */
  packagingOptions?: BuyablePackaging[];
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

/**
 * Something preventing checkout.
 *
 * The backend names each one with a code and a human message. The storefront
 * shows the message and uses the code only to decide *where* to show it — it
 * never rewrites the explanation, because the server knows the rule and this
 * code would only paraphrase it wrongly.
 */
export interface CartIssue {
  code: string;
  message: string;
  meta?: Record<string, unknown>;
  itemId?: string;
}

export interface CartLine {
  itemId: string;
  productId: string;
  variantId: string | null;
  name: string;
  /**
   * The chosen option's own name — "3 ml", "Box of 100" — or null where the
   * product has no options.
   *
   * A customer can buy two options of one product, and those are two lines
   * whose `name` is the same word. This is what tells them apart on the page.
   */
  variantName: string | null;
  slug: string;
  /** The variant's SKU when one is chosen, otherwise the product's. */
  sku: string;
  imageUrl: string | null;
  quantity: number;
  unitPrice: Money;
  lineSubtotal: Money;
  /** This line's share of any coupon discount. Zero when none applies. */
  discount: Money;
  taxAmount: Money;
  lineTotal: Money;
  taxRatePercent: string;
  taxInclusive: boolean;
  /**
   * What the customer could actually have right now.
   *
   * Published on the *cart* but not on the public catalogue: once someone has
   * committed to an item, they need to know whether it can ship, and the
   * number is scoped to their own cart rather than browsable by anyone.
   */
  availableQty: number | null;
  isRecurringEligible: boolean;
  /** The cart's copy carries no recurring flag — that sits on the line. */
  purchaseRules: Omit<PurchaseRules, 'isRecurringEligible'>;
  /**
   * How many cartons, and the carton size they were shown.
   *
   * Read off the line's own snapshot rather than today's setting: a basket
   * agreed at 500 to a carton keeps reading "2 cartons (1,000 pieces)" even
   * after the operator re-specifies the carton, because that is what they put
   * in it.
   *
   * Optional, and `unit` can still say `PIECE` or `INNER_PACK` on a line put
   * in a basket before the shop settled on the carton. Nothing new is ever
   * written that way.
   */
  ordering?: {
    unit: 'PIECE' | 'INNER_PACK' | 'OUTER_CARTON';
    /** Cartons on the operator's line; pieces on a seller's. */
    unitQuantity: number;
    piecesPerUnit: number;
    /**
     * How this line's quantity may be moved, in its own unit.
     *
     * The OFFER's terms on a seller's line, so the stepper steps by what the
     * seller will actually pick and pack rather than by the product row's
     * figure — which on a product a seller described was typed by somebody
     * else and is not applied to their line by the server either.
     *
     * Optional: a response cached from before these existed steps by one,
     * which is what it did before.
     */
    minimumOrderQuantity?: number;
    orderIncrement?: number;
    maximumOrderQuantity?: number | null;
  } | null;
  /**
   * The buyer's special instruction for this line, or null where none was
   * given.
   *
   * Per line rather than per order, because "the 316 grade, not 304" is about
   * one product and an order note is read by everybody. Editable from the
   * basket right up until the order is placed, at which point it is frozen
   * onto the order line.
   *
   * Optional on the type, because a response cached from before the field
   * existed does not carry it and a basket must still render.
   */
  note?: string | null;
  /**
   * The bulk breakdown this line was bought at, or null on an ordinary line.
   *
   * The FROZEN snapshot, not the seller's current configuration. A basket
   * holding "2 UK pallets × 50 cartons × 24 units" keeps saying that even
   * after the seller re-specifies the pallet at 48 to a layer, because that is
   * what the shopper agreed to — and the server tells them the two have
   * diverged rather than quietly applying the new figure.
   *
   * Optional on the type: a response cached from before this existed does not
   * carry it, and a basket must still render.
   */
  packaging?: LinePackaging | null;
  /** Per-line problems: out of stock, below minimum, no longer published. */
  issues: CartIssue[];
}

export interface CartTotals {
  subtotal: Money;
  discount: Money;
  tax: Money;
  shipping: Money;
  grandTotal: Money;
}

/** The coupon in force, or the one that stopped qualifying and why. */
export interface AppliedCoupon {
  code: string;
  name: string;
  description: string | null;
  discountPercent: string;
  discount: Money;
  rejection: { code: string; message: string; meta?: Record<string, unknown> } | null;
}

/** An advertised coupon, evaluated against the cart as it stands. */
export interface OfferedCoupon {
  code: string;
  name: string;
  description: string | null;
  discountPercent: string;
  minOrder: Money;
  /** True when the cart already clears the threshold and has eligible lines. */
  eligibleNow: boolean;
}

export interface Cart {
  cartId: string;
  currency: string;
  lines: CartLine[];
  totals: CartTotals;
  coupon: AppliedCoupon | null;
  availableCoupons: OfferedCoupon[];
  /** The server's verdict. The checkout button follows this, not a local sum. */
  checkoutReady: boolean;
  blockingIssues: CartIssue[];
  requiresApproval: boolean;
  approvalReason: string | null;
  itemCount: number;
  /**
   * True when something in this basket has to be QUOTED for delivery rather
   * than priced instantly — a container, or a pallet no carrier on the
   * seller's account can take.
   *
   * NOT a blocker, and the checkout must not treat it as one. The goods are
   * priced; the freight is not, and the review screen says so and offers to
   * raise the request. A basket that refused to proceed over it would make
   * container ordering impossible while telling the buyer nothing was wrong.
   */
  requiresFreightQuote?: boolean;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface Address {
  id: string;
  kind: 'BILLING' | 'SHIPPING' | 'BOTH';
  label: string | null;
  contactName: string;
  contactPhone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isDefaultBilling: boolean;
  isDefaultShipping: boolean;
  archivedAt: string | null;
}

export interface CustomerProfile {
  id: string;
  email: string;
  /** When the address was confirmed. Null on an account that never has been. */
  emailVerifiedAt: string | null;
  /**
   * The canonical name, used on every order, invoice and delivery note.
   *
   * Composed server-side from `firstName`/`lastName` whenever those are sent —
   * see `updateCustomer`. Never split client-side to fill the two fields
   * below: "Van der Berg" is one surname and "Jean Paul" is one forename, and
   * a guessed split is one the customer cannot tell was guessed.
   */
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  organization: string | null;
  department: string | null;
  jobTitle: string | null;
  /** The delivery contact number on the profile. A courier rings this one. */
  phone: string | null;
  /**
   * The number on the identity, and whether it has been confirmed.
   *
   * A different column from `phone` above, because they answer different
   * questions: this one identifies the account and only moves through the
   * verified change flow.
   */
  accountPhone: string | null;
  accountPhoneVerifiedAt: string | null;
  /** Waiting on a confirmation link. Null when there is no change in flight. */
  pendingEmail: string | null;
  pendingPhone: string | null;
  /** All three mean "never chosen" when null, not a default. */
  preferredCountry: string | null;
  preferredCurrency: string | null;
  preferredLanguage: string | null;
  gstin: string | null;
  vatNumber: string | null;
  /** Null means "never checked", which is not the same as invalid. */
  vatNumberValid: boolean | null;
  vatNumberCheckedAt: string | null;
  consentAcceptedAt: string | null;
  consentVersion: string | null;
  activatedAt: string | null;
  lastLoginAt: string | null;
  orderCount: number;
  scheduleCount: number;
  wishlistCount: number;
}

/** What closing an account would do, before it is done. */
export interface ClosureImpact {
  activeScheduleCount: number;
  hasAutoPay: boolean;
  /** Orders still owing money. They survive closure and are still owed. */
  unpaidOrderCount: number;
}

export interface WishlistItem {
  id: string;
  productId: string;
  productName: string;
  productSlug: string;
  sku: string;
  variant: { id: string; name: string; sku: string } | null;
  imageUrl: string | null;
  /** Null where the product is not priced in the requested currency. */
  priceMinor: string | null;
  currency: string;
  /**
   * What `priceMinor` is a price for — the operator's carton, or a piece.
   *
   * Optional so a response cached from before it existed still renders; the
   * carton is what it falls back to, which is what every such response can
   * only have been. See `sellUnitOf`.
   */
  sellUnit?: ProductSellUnit | null;
  /** Whether it could be added to a basket right now. */
  isAvailable: boolean;
  savedAt: string;
}

export interface AccountCouponOffer {
  code: string;
  name: string;
  description: string | null;
  discountPercent: string;
  /** Minor units, as a string. Null when this currency has no threshold row. */
  minOrderMinor: string | null;
  validUntil: string | null;
}

export interface AccountCouponUse {
  code: string;
  name: string;
  orderNumber: string;
  discountMinor: string;
  currency: string;
  usedAt: string;
}

export interface AccountNotification {
  id: string;
  /** The event that produced it, e.g. `order.confirmed`. */
  eventKey: string;
  subject: string;
  sentAt: string | null;
  relatedType: string | null;
  relatedId: string | null;
}

export interface AccountResponse {
  profile: CustomerProfile;
  purchasingLimits: {
    perOrderMinMinor: string | null;
    perOrderMaxMinor: string | null;
    requiresOrderApproval: boolean;
    currency: string;
  };
  spend: {
    monthToDateMinor: string;
    capMinor: string | null;
    remainingMinor: string | null;
    currency: string;
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface OrderTotals {
  subtotal: Money;
  discount: Money;
  tax: Money;
  shipping: Money;
  grandTotal: Money;
  paid: Money;
  refunded: Money;
}

export interface OrderListItem {
  id: string;
  orderNumber: string;
  status: string;
  source: string;
  currency: string;
  totals: OrderTotals;
  paymentMode: string | null;
  placedAt: string | null;
  confirmedAt: string | null;
  itemCount: number;
  createdAt: string;
}

export interface OrderItem {
  /** The order line's own id, not the product's. */
  id: string;
  /** What to add back to a cart on reorder. */
  productId: string;
  variantId: string | null;
  /**
   * A snapshot, taken when the order was placed.
   *
   * Not a live lookup: a product renamed or repriced afterwards must not
   * rewrite what somebody already bought.
   */
  name: string;
  sku: string;
  variantName: string | null;
  imageUrl: string | null;
  /** Pieces. What the warehouse picks and what `unitPrice` is per. */
  quantity: number;
  /**
   * What the buyer ordered, in the unit they ordered it in.
   *
   * Cartons on anything placed since this shop settled on the carton. Read
   * off the line's own snapshot, so an order placed when a carton held a
   * different number still describes itself correctly.
   *
   * Optional because an order served by a server that predates the field
   * legitimately lacks it, and a screen that assumed it would print "0
   * cartons" on somebody's receipt.
   */
  ordering?: {
    unit: 'PIECE' | 'INNER_PACK' | 'OUTER_CARTON';
    unitQuantity: number;
    piecesPerUnit: number;
  } | null;
  unitPrice: Money;
  lineSubtotal: Money;
  tax: Money;
  lineTotal: Money;
  taxRatePercent: string;
  /**
   * The special instruction the buyer gave for this line, frozen at checkout.
   *
   * A snapshot like the name and the price beside it: the basket it was typed
   * into is emptied when the order is placed, so these are the words as they
   * were agreed rather than as they might be edited later.
   *
   * Optional, because an order served by a server that predates the field
   * legitimately lacks it.
   */
  note?: string | null;
}

export interface OrderTimelineEntry {
  from: string | null;
  to: string;
  reason: string | null;
  at: string;
}

export interface OrderShipment {
  /**
   * The seller who sent this box, or null when the shop sent it itself.
   *
   * A marketplace order can arrive as two parcels on two days from two
   * businesses, and a tracking list that does not say which is which is a
   * list of numbers the buyer cannot match to anything.
   */
  sentBy: string | null;
  /**
   * Whether tracking updates arrive on their own.
   *
   * Null where no external carrier account is behind the parcel, which is
   * every consignment carried inside this system - those do move on their own.
   * False means somebody enters the updates, or they live on the carrier's own
   * page, and the buyer is told so rather than left refreshing.
   */
  trackingIsAutomatic?: boolean | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: string;
  dispatchedAt: string | null;
  deliveredAt: string | null;
}

export interface OrderApproval {
  decision?: string;
  comment?: string | null;
  decidedAt?: string | null;
}

export interface OrderAddress {
  contactName: string | null;
  contactPhone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country: string;
}

/**
 * An order as its own customer sees it.
 *
 * Deliberately absent, and not to be added:
 *   - `internalNote` — written by staff about the order, not for the customer.
 *   - payment-link tokens — the link lives in the approver's email and nowhere
 *     else. Exposing it through an account API would make emailing it pointless.
 */
export interface OrderDetail extends OrderListItem {
  items: OrderItem[];
  timeline: OrderTimelineEntry[];
  shippingAddress: OrderAddress | null;
  billingAddress: OrderAddress | null;
  shippingMethodName: string | null;
  customerNote: string | null;
  cancelReason: string | null;
  shipments: OrderShipment[];
  approval: OrderApproval | null;
  /**
   * How the customer said they would pay, and with which of their cards.
   *
   * Read back by the payment page rather than carried there in navigation
   * state, so a reload — or returning to an unpaid order from an email hours
   * later — offers what they chose rather than starting the decision again.
   *
   * No gateway appears here. It is resolved from the instrument on the server
   * and is the operator's business, not something a customer's order record
   * has any reason to name.
   */
  preferredPaymentInstrument: PaymentInstrument | null;
  preferredPaymentMethodId: string | null;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export type PaymentProviderKind = 'RAZORPAY' | 'STRIPE';

/**
 * Which instruments to ask the gateway to show.
 *
 * A preference the customer expresses before the sheet opens — not a record of
 * what they paid with, which only the backend learns from the provider.
 */
export type PaymentMethodHint = 'ANY' | 'UPI';

/** One gateway the operator has connected, as offered at checkout. */
export interface PaymentGateway {
  provider: PaymentProviderKind;
  label: string;
  /** Instruments worth naming separately. `ANY` is the gateway's own set. */
  methods: PaymentMethodHint[];
  /** ISO-4217 codes this gateway may be offered for; null means no limit. */
  currencies: string[] | null;
}

/** What `GET /payments/gateways` returns. */
export interface PaymentGateways {
  gateways: PaymentGateway[];
  /** Preselected at checkout. Null when nothing is connected. */
  defaultProvider: PaymentProviderKind | null;
}

/**
 * What the customer is asked to pay with.
 *
 * Instruments, not gateways. Nobody buying laboratory consumables knows or
 * cares which acquirer settles the money, and asking them to choose between
 * two of them is asking a question they have no basis for answering. Which
 * gateway serves each of these is decided on the server and never travels
 * here as a choice.
 */
export type PaymentInstrument = 'CREDIT_CARD' | 'DEBIT_CARD' | 'UPI';

/** One way to pay, as offered by `GET /payments/instruments`. */
export interface InstrumentOffer {
  instrument: PaymentInstrument;
  /**
   * Whether a card paid with here can be kept for next time.
   *
   * False for UPI, which produces nothing to keep, and false where the gateway
   * behind it cannot store one. The "save this card" tick is hidden rather
   * than shown-and-ignored: an offer the server cannot honour is worse than no
   * offer.
   */
  canSaveCard: boolean;
  /**
   * Whether a saved card can be charged from these pages.
   *
   * True on Stripe. False on Razorpay, whose saved cards are picked inside its
   * own sheet - charging one named token needs a server-to-server API open
   * only to PCI-DSS-certified merchants. Used to word what happens next, not
   * to hide anything.
   */
  savedCardsChargeableHere: boolean;
}

/** What `GET /payments/instruments?currency=` returns. */
export interface PaymentInstruments {
  instruments: InstrumentOffer[];
  /**
   * Whether this installation settles payments on request, with no gateway.
   *
   * A testing fixture. The backend decides it, and the environment it needs
   * refuses to boot in production - so this is never true anywhere a customer
   * could be looking at it.
   */
  mockPayments: boolean;
}

/**
 * A card the customer has stored, as much as anyone is allowed to know.
 *
 * Brand and last four and nothing else that could pay for anything. No card
 * number reaches this application, let alone this browser - what is stored is
 * a token held by the gateway, which is both what the RBI requires since
 * October 2022 and what keeps every deployment out of PCI DSS scope.
 */
export interface SavedCard {
  id: string;
  provider: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  funding: string | null;
  status: string;
  isDefault: boolean;
  /**
   * Which heading this card appears under at a checkout. Null when the gateway
   * would not say - a prepaid card - in which case it appears under both
   * rather than being filed wrongly under one.
   */
  instrument: PaymentInstrument | null;
  /**
   * What its owner agreed to.
   *
   * `CHECKOUT` means "keep this so I need not retype it"; `OFF_SESSION` means
   * "charge this while I am not here". Only the latter may be chosen for a
   * scheduled order, and offering a `CHECKOUT` card there would be offering
   * something the server is about to refuse.
   */
  consentScope: string;
}

/** What `POST /payments/orders/:orderId/session` returns. */
export interface PaymentSession {
  paymentTransactionId: string;
  provider: string;
  /**
   * TEST or LIVE, straight from the gateway connection the admin activated.
   * Shown to the customer in TEST mode so nobody mistakes a sandbox run for a
   * real purchase.
   */
  mode: 'TEST' | 'LIVE';
  providerOrderId: string;
  amount: Money;
  /**
   * Everything the provider's hosted UI needs, and nothing else.
   *
   * Carries the *publishable* key only — the key secret never leaves the
   * server, and nothing in here is worth logging.
   */
  checkoutPayload: Record<string, string | number>;
  /** What the customer picked, echoed back so a reload shows the same thing. */
  instrument: PaymentInstrument | null;
  /**
   * What this browser has to do next.
   *
   * Three genuinely different situations that cannot be told apart from the
   * rest of this object:
   *
   *   OPEN_PROVIDER_UI   - mount the gateway's form or sheet. The ordinary
   *                        case for a new card, for UPI, and for every
   *                        Razorpay payment.
   *   AUTHENTICATE       - the charge is already under way on a stored card
   *                        and the bank wants the cardholder. Run the
   *                        challenge against `client_secret`.
   *   AWAIT_CONFIRMATION - it went through with no challenge. Nothing to do
   *                        but wait for the backend, which is still the only
   *                        thing that can say the order is paid.
   */
  next: 'OPEN_PROVIDER_UI' | 'AUTHENTICATE' | 'AWAIT_CONFIRMATION';
}

/** What `POST /cart/checkout` returns. */
export interface CheckoutResult {
  orderId: string;
  orderNumber: string;
  status: string;
  currency: string;
  totals: CartTotals;
  requiresApproval: boolean;
  paymentMode: 'ONLINE' | 'PAYMENT_LINK';
  /**
   * True when this exact idempotency key had already been used.
   *
   * Lets the page say "your order was already placed" rather than "your order
   * was placed" — without creating a second one either way.
   */
  replayed?: boolean;
}

/**
 * The order's payment state, as the *backend* understands it.
 *
 * `paid` becomes true only when a signature-verified provider event has been
 * applied. A client redirect saying "success" proves nothing — the browser is
 * not a trusted reporter of whether money moved.
 */
export interface PaymentStatus {
  status: string;
  paid: boolean;
  orderStatus: string;
}

// ---------------------------------------------------------------------------
// Recurring schedules
// ---------------------------------------------------------------------------

export interface ScheduleItem {
  productId: string;
  variantId: string | null;
  quantity: number;
  name?: string;
  sku?: string;
  /** Present on the detail read, so a line can link to its product page. */
  slug?: string;
  /**
   * The product's purchasing rules, on the detail read only.
   *
   * The same shape the catalogue sends, so one quantity control takes a
   * schedule line and a product page line without knowing the difference.
   * Optional because the list read does not carry items at all.
   */
  purchaseRules?: {
    minOrderQty: number;
    maxOrderQty: number | null;
    qtyIncrement: number;
  };
}

/**
 * One thing standing in the way of a delivery.
 *
 * Three severities, and they mean genuinely different things: BLOCK is a plan
 * that cannot run at all, HOLD is this cycle withdrawn and the plan carrying
 * on, WARN is worth saying and stops nothing. A screen that treats all three
 * as errors tells a customer their standing order is broken when a price
 * moved by two rupees.
 */
export interface ScheduleProblem {
  severity: 'BLOCK' | 'HOLD' | 'WARN';
  code: string;
  message: string;
  productId?: string;
}

/** One priced line of an estimate. */
export interface ScheduleEstimateLine {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string;
  variantName: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPrice: Money;
  lineTotal: Money;
  /** Null for a product this store does not count. Never read as zero. */
  availableQty: number | null;
  /**
   * What this line is counted in, and the conversion it was quoted on.
   *
   * Sent by `quoteSchedule` and previously not declared here, so every screen
   * showing an estimate multiplied the quoted piece price by the deployment's
   * carton instead — right for the operator's lines and five hundred times too
   * large for a seller's.
   */
  ordering?: {
    unit: 'PIECE' | 'INNER_PACK' | 'OUTER_CARTON';
    unitQuantity: number;
    piecesPerUnit: number;
  } | null;
  substitutedFor: { productId: string; name: string } | null;
}

/**
 * What a schedule would cost if it ran now.
 *
 * An estimate, and the screens say so: every occurrence is repriced against
 * the catalogue, the destination's tax and the customer's limits at the moment
 * it runs, so a plan created in April at one price has not locked it in.
 */
export interface ScheduleEstimate {
  scheduleId: string;
  currency: string;
  lines: ScheduleEstimateLine[];
  totals: {
    subtotal: Money;
    discount: Money;
    tax: Money;
    shipping: Money;
    grandTotal: Money;
  };
  /** False is information for the customer, not an error state. */
  ok: boolean;
  problems: ScheduleProblem[];
  /** Null where nothing priced, so a screen shows a dash and not 0.00. */
  estimatedTotal: Money | null;
}

/**
 * What `POST /recurring-schedules` returns.
 *
 * An acknowledgement, not the whole schedule — the full record is read back
 * from the detail route, which is where the customer is sent next anyway.
 */
export interface ScheduleCreated {
  scheduleId: string;
  name: string;
  /** The server's own description of the recurrence, for an instant summary. */
  summary: string;
  nextRunAt: string | null;
  paymentMode: string;
}

export interface Schedule {
  id: string;
  name: string;
  status: string;
  /** The server's own description of the recurrence. Never rebuilt here. */
  summary: string;
  frequency: string;
  intervalDays: number | null;
  weekday: number | null;
  monthDay: number | null;
  /** EVERY_N_MONTHS: 2, 3, 6 or 12. The date itself comes from `startDate`. */
  intervalMonths: number | null;
  timezone: string;
  runAtMinute: number;
  startDate: string;
  endDate: string | null;
  maxOccurrences: number | null;
  occurrenceCount: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  paymentMode: string;
  payerEmail: string | null;
  hasMandate: boolean;
  consentAcceptedAt: string | null;
  failureCount: number;
  maxFailures: number;
  pausedReason: string | null;
  cancelReason: string | null;
  itemCount: number;
  /** ONE_TIME is Buy Later; RECURRING is a standing order. */
  kind?: string;
  /**
   * The moment this plan stops accepting changes for its next delivery.
   *
   * Sent so a screen can say what it will refuse instead of offering a button
   * that then errors. Null when there is no next delivery to be early for.
   */
  editableUntil?: string | null;
  /** Only on a list read that asked to be priced. See `ScheduleEstimate`. */
  estimatedTotal?: Money | null;
  estimateOk?: boolean;
  /** Where it delivers, on the detail read. The whole address, not just an id. */
  shippingAddress?: Address | null;
  billingAddress?: Address | null;
  items?: ScheduleItem[];
  occurrences?: {
    id: string;
    /**
     * The slot this cycle serves, as the API names it.
     *
     * Named `plannedRunAt` because that is the column and the field on the
     * wire. It was `scheduledFor` here and on no server response, so every
     * date in the delivery history rendered as an invalid one.
     */
    plannedRunAt: string;
    status: string;
    orderId: string | null;
    orderNumber: string | null;
    total?: Money | null;
    failureMessage: string | null;
    skipReason: string | null;
    /** A customer skip and an engine hold both end in SKIPPED. */
    skippedByUser?: boolean;
    attemptCount?: number;
    /** True only while the customer can still skip or re-date this one. */
    canModify?: boolean;
  }[];
}

// ---------------------------------------------------------------------------
// Account -> Automatic payment
//
// All that is left of a larger surface. The ERP shapes that used to sit here
// went with the screens: a connection is configured by an administrator under
// Settings -> ERP, and the storefront neither shows one nor has a type for
// it. Auto-pay stayed, and had to - nobody can consent on somebody else's
// behalf to money leaving their account.
// ---------------------------------------------------------------------------

export type AutoPayStatus = 'DISABLED' | 'ACTIVE' | 'PAUSED';
export type AutoPayRetryPreference = 'NONE' | 'ONCE' | 'STANDARD';

export interface AutoPaySettings {
  status: AutoPayStatus;
  enabled: boolean;
  paymentMethodId: string | null;
  paymentMethodLabel: string | null;
  paymentMethodUsable: boolean;
  /** Minor units, as a string. Never a JS number - see the API client. */
  maxTransactionMinor: string | null;
  approvalThresholdMinor: string | null;
  limitCurrency: string | null;
  retryPreference: AutoPayRetryPreference;
  notifyOnCharge: boolean;
  notifyOnFailure: boolean;
  consentAcceptedAt: string | null;
  consentVersion: string | null;
  consentWithdrawnAt: string | null;
  enabledAt: string | null;
  pausedAt: string | null;
  currentConsentVersion: string;
}
