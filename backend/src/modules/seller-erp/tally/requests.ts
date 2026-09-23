/**
 * The XML this system sends TallyPrime.
 *
 * Two shapes, and Tally's own vocabulary for them:
 *
 *   EXPORT  - "send me something". A report or a collection. Used to list the
 *             open companies and to read the masters the mapping screen offers.
 *   IMPORT  - "take this". A voucher or a master. Everything that writes.
 *
 * Both travel inside an `<ENVELOPE>` with a `<HEADER>` naming the request and a
 * `<BODY>` carrying it. There is no schema, no namespace and no versioning -
 * Tally matches on tag names - so every tag here is a literal this module owns
 * and nothing in it is ever assembled from a request body.
 *
 * THE PACKAGING RULE, WHICH IS THE POINT OF THIS FILE
 *
 * A buyer who orders 2 UK pallets of 50 cartons of 24 has bought 2,400 units.
 * The voucher posts **2,400**, in the stock item's own base unit, because that
 * is what leaves the warehouse and what the seller's stock has to reconcile
 * to. Posting "2" would tell Tally two units left the building.
 *
 * The packaging is not thrown away for that. It goes into the narration and
 * into the line's own description, so an accountant reading the voucher sees
 * "2 UK pallets x 50 cartons x 24 units" beside the 2,400 and can check one
 * against the other.
 *
 * The ONE exception is deliberate and opt-in: a seller who has created a
 * compound unit in Tally ("PLT of 1200 PCS") and mapped it may post in that
 * unit instead, with Tally's own conversion factor doing the arithmetic. That
 * is the only route by which anything other than a base-unit quantity reaches
 * a voucher, it requires a confirmed `ALTERNATE_UNIT` mapping, and the factor
 * is checked against ours before it is used.
 */
import { element, tallyAmount, tallyDate, wrap, type XmlAttributes } from './xml.js';

/** Tally's own name for the two request kinds. */
export type TallyRequestKind = 'Export' | 'Import';

/**
 * The envelope every request travels in.
 *
 * `companyName` goes into `SVCURRENTCOMPANY`, which is how Tally is told WHICH
 * open company the request is about. Omitting it makes Tally use whichever
 * company happens to be in front, which on a machine with two companies open -
 * an ordinary thing at a financial year boundary - posts a month of sales into
 * the wrong set of books. It is required on every write for that reason.
 */
export interface EnvelopeOptions {
  kind: TallyRequestKind;
  /** `Collection`, `Data`, `Object`, or the report's own name. */
  type: string;
  /** The report or collection being asked for, or the import's target. */
  id: string;
  companyName?: string | null;
  /** Extra `<STATICVARIABLES>` entries, already valid XML. */
  staticVariables?: string;
  body: string;
}

export function envelope(options: EnvelopeOptions): string {
  const variables = [
    element('SVEXPORTFORMAT', '$$SysName:XML'),
    options.companyName === null || options.companyName === undefined
      ? ''
      : element('SVCURRENTCOMPANY', options.companyName),
    options.staticVariables ?? '',
  ].join('');

  const header = wrap(
    'HEADER',
    [
      element('TALLYREQUEST', options.kind),
      element('TYPE', options.type),
      element('ID', options.id),
    ].join(''),
  );

  const desc = wrap('DESC', wrap('STATICVARIABLES', variables));

  const body = wrap('BODY', wrap('EXPORTDATA', wrap('REQUESTDESC', desc + options.body)));

  return `<?xml version="1.0" encoding="UTF-8"?>${wrap('ENVELOPE', header + body)}`;
}

/**
 * "Which companies are open?"
 *
 * The first thing asked on every connection test, and the only request that
 * does NOT name a company - it is the request that finds out what the
 * companies are. A reply listing companies but not the configured one is what
 * produces `COMPANY_NOT_LOADED` rather than a generic failure.
 */
export function companyListRequest(): string {
  return envelope({
    kind: 'Export',
    type: 'Collection',
    id: 'List of Companies',
    body: wrap(
      'TDL',
      wrap(
        'TDLMESSAGE',
        wrap(
          'COLLECTION',
          [
            element('TYPE', 'Company'),
            element('NATIVEMETHOD', 'Name'),
            element('NATIVEMETHOD', 'StartingFrom'),
            element('NATIVEMETHOD', 'Guid'),
          ].join(''),
          { NAME: 'GloviaCompanies', ISMODIFY: 'No' },
        ),
      ),
    ),
  });
}

/** Which Tally collection each kind of master lives in. */
export const MASTER_COLLECTIONS = Object.freeze({
  LEDGER: { collection: 'Ledger', tag: 'LEDGER', methods: ['Name', 'Parent', 'Guid'] },
  STOCK_ITEM: {
    collection: 'StockItem',
    tag: 'STOCKITEM',
    methods: ['Name', 'Parent', 'BaseUnits', 'AdditionalUnits', 'Guid'],
  },
  GODOWN: { collection: 'Godown', tag: 'GODOWN', methods: ['Name', 'Parent', 'Guid'] },
  VOUCHER_TYPE: {
    collection: 'VoucherType',
    tag: 'VOUCHERTYPE',
    methods: ['Name', 'Parent', 'Guid'],
  },
  UNIT: {
    collection: 'Unit',
    tag: 'UNIT',
    methods: ['Name', 'BaseUnits', 'AdditionalUnits', 'Conversion', 'DecimalPlaces', 'Guid'],
  },
  COST_CENTRE: { collection: 'CostCentre', tag: 'COSTCENTRE', methods: ['Name', 'Parent', 'Guid'] },
} as const);

export type MasterCollectionKey = keyof typeof MASTER_COLLECTIONS;

/**
 * "Send me the ledgers / stock items / godowns / voucher types / units."
 *
 * Read-only, and it is what fills the mapping picker. Nothing here is treated
 * as authoritative afterwards - see `SellerErpMasterCache`, which is named a
 * cache precisely so nobody mistakes it for the source of truth. A mapping
 * saved against a ledger since renamed in Tally fails at post time with
 * Tally's own message, which is the right place to find out.
 */
export function masterListRequest(key: MasterCollectionKey, companyName: string): string {
  const spec = MASTER_COLLECTIONS[key];

  return envelope({
    kind: 'Export',
    type: 'Collection',
    id: `Glovia${spec.collection}s`,
    companyName,
    body: wrap(
      'TDL',
      wrap(
        'TDLMESSAGE',
        wrap(
          'COLLECTION',
          [
            element('TYPE', spec.collection),
            ...spec.methods.map((method) => element('NATIVEMETHOD', method)),
          ].join(''),
          { NAME: `Glovia${spec.collection}s`, ISMODIFY: 'No' },
        ),
      ),
    ),
  });
}

/**
 * "Send me the closing stock for every item."
 *
 * Only used where the seller has switched inventory syncing on and chosen an
 * authority. Nothing writes a stock figure off the back of it unless that
 * choice was `TALLY` - see `SellerErpInventoryAuthority`, where the four
 * answers and their consequences are set out.
 */
export function stockSummaryRequest(companyName: string): string {
  return envelope({
    kind: 'Export',
    type: 'Collection',
    id: 'GloviaStockSummary',
    companyName,
    body: wrap(
      'TDL',
      wrap(
        'TDLMESSAGE',
        wrap(
          'COLLECTION',
          [
            element('TYPE', 'StockItem'),
            element('NATIVEMETHOD', 'Name'),
            element('NATIVEMETHOD', 'ClosingBalance'),
            element('NATIVEMETHOD', 'BaseUnits'),
            element('NATIVEMETHOD', 'Guid'),
          ].join(''),
          { NAME: 'GloviaStockSummary', ISMODIFY: 'No' },
        ),
      ),
    ),
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** An import: one or more masters or vouchers, into one company. */
export function importRequest(input: {
  companyName: string;
  /** `Vouchers`, `All Masters`. Tally's own report names. */
  reportName: string;
  /** The `<TALLYMESSAGE>` fragments, already valid XML. */
  messages: string;
}): string {
  const header = wrap(
    'HEADER',
    [element('TALLYREQUEST', 'Import'), element('TYPE', 'Data'), element('ID', input.reportName)].join(''),
  );

  const desc = wrap(
    'DESC',
    wrap('STATICVARIABLES', element('SVCURRENTCOMPANY', input.companyName)),
  );

  const data = wrap('DATA', wrap('TALLYMESSAGE', input.messages, { 'xmlns:UDF': 'TallyUDF' }));

  const body = wrap('BODY', wrap('IMPORTDATA', desc + data));

  return `<?xml version="1.0" encoding="UTF-8"?>${wrap('ENVELOPE', header + body)}`;
}

/** One line of a voucher, as this system knows it. */
export interface VoucherLine {
  /** The stock item's name in Tally. From a confirmed STOCK_ITEM mapping. */
  stockItemName: string;
  /**
   * BASE UNITS. Always. 2,400 for a two-pallet order of 50x24, never 2.
   *
   * See the file header: the only route to any other figure is an explicitly
   * mapped alternate unit, and it comes through `alternateUnit` below rather
   * than by changing this.
   */
  baseQuantity: number;
  /** The base unit's own name in Tally - PCS, NOS, BOX. */
  baseUnitName: string;
  /**
   * The seller's compound unit, where they have mapped one and asked for
   * packages to post in it.
   *
   * `factor` is base units per alternate unit, and it is checked against the
   * packaging's own figure before the voucher is built: a Tally unit declaring
   * 1,000 to a pallet against packaging that says 1,200 would post a quantity
   * that reconciles to neither.
   */
  alternateUnit?: { name: string; quantity: number; factor: number } | null;
  /** Minor units, and the exponent to render them at. */
  amountMinor: bigint;
  rateMinor: bigint;
  currencyExponent: number;
  /** The godown, from a confirmed GODOWN mapping. Null where none is mapped. */
  godownName: string | null;
  batchName: string | null;
  /** The income ledger this line credits. */
  salesLedgerName: string;
  /**
   * "2 UK pallets x 50 cartons x 24 units", or null on an ordinary line.
   *
   * Goes onto the line as its own description. This is what makes the base
   * quantity checkable by a person: 2,400 on its own is a number, and 2,400
   * with the arithmetic beside it is a figure somebody can verify.
   */
  packagingDescription: string | null;
}

/** A ledger entry - the party, the taxes, the freight, the rounding. */
export interface VoucherLedgerEntry {
  ledgerName: string;
  /**
   * Tally's sign convention, and it is the opposite of intuition:
   * `isDeemedPositive = Yes` means a DEBIT. The party is debited on a sale,
   * the sales and tax ledgers are credited.
   */
  isDeemedPositive: boolean;
  /** Minor units, SIGNED as Tally wants it: credits negative, debits positive. */
  amountMinor: bigint;
  currencyExponent: number;
  costCentreName?: string | null;
}

export interface VoucherInput {
  /** `Sales Order`, `Sales`, `Receipt`, `Credit Note` - the MAPPED name. */
  voucherTypeName: string;
  /** Our own reference. Tally keys duplicates on it via REMOTEID. */
  remoteId: string;
  voucherNumber: string | null;
  date: Date;
  /** The party ledger, from a confirmed PARTY_LEDGER mapping. */
  partyLedgerName: string;
  /** What the order is called on our side, for the accountant. */
  reference: string | null;
  narration: string | null;
  lines: VoucherLine[];
  ledgerEntries: VoucherLedgerEntry[];
  /** `Yes` puts it in the books; there is no other value this system sends. */
  isInvoice: boolean;
}

/**
 * One voucher.
 *
 * `REMOTEID` is the duplicate guard ON TALLY'S SIDE, and it is not the only
 * one: the outbox's unique idempotency key stops the same event being queued
 * twice, `SellerErpExternalReference` stops the same entity acquiring two
 * vouchers by two routes, and this stops Tally itself writing a second copy if
 * a reply is lost after Tally committed but before we recorded it. Three
 * guards because the failure they prevent - a duplicate Sales Invoice - is a
 * tax return that does not reconcile.
 */
export function voucher(input: VoucherInput): string {
  const attributes: XmlAttributes = {
    REMOTEID: input.remoteId,
    VCHTYPE: input.voucherTypeName,
    ACTION: 'Create',
    OBJVIEW: input.isInvoice ? 'Invoice Voucher View' : 'Accounting Voucher View',
  };

  const head = [
    element('DATE', tallyDate(input.date)),
    element('EFFECTIVEDATE', tallyDate(input.date)),
    element('VOUCHERTYPENAME', input.voucherTypeName),
    input.voucherNumber === null ? '' : element('VOUCHERNUMBER', input.voucherNumber),
    element('PARTYLEDGERNAME', input.partyLedgerName),
    // Tally still reads the older spelling on some builds and the newer one on
    // others. Both are sent; a build that knows only one ignores the other,
    // and the alternative is a party name that silently does not attach.
    element('PARTYNAME', input.partyLedgerName),
    input.reference === null ? '' : element('REFERENCE', input.reference),
    input.narration === null ? '' : element('NARRATION', input.narration),
    element('ISINVOICE', input.isInvoice ? 'Yes' : 'No'),
    element('PERSISTEDVIEW', input.isInvoice ? 'Invoice Voucher View' : 'Accounting Voucher View'),
  ].join('');

  const inventory = input.lines.map(inventoryEntry).join('');
  const ledgers = input.ledgerEntries.map(ledgerEntry).join('');

  return wrap('VOUCHER', head + inventory + ledgers, attributes);
}

function inventoryEntry(line: VoucherLine): string {
  /*
   * THE QUANTITY.
   *
   * Base units unless the seller explicitly mapped a compound unit, and the
   * base unit's NAME travels with the number - "2400 PCS". Tally reads a bare
   * number against the stock item's own base unit, which is usually right and
   * is exactly the kind of "usually" that puts 2,400 boxes where 2,400 pieces
   * belong on the one item configured differently.
   */
  const quantity =
    line.alternateUnit === null || line.alternateUnit === undefined
      ? `${String(line.baseQuantity)} ${line.baseUnitName}`
      : `${String(line.alternateUnit.quantity)} ${line.alternateUnit.name} = ${String(line.baseQuantity)} ${line.baseUnitName}`;

  const accounting = wrap(
    'ACCOUNTINGALLOCATIONS.LIST',
    [
      element('LEDGERNAME', line.salesLedgerName),
      element('ISDEEMEDPOSITIVE', 'No'),
      element('AMOUNT', `-${tallyAmount(line.amountMinor, line.currencyExponent)}`),
    ].join(''),
  );

  const batch =
    line.godownName === null && line.batchName === null
      ? ''
      : wrap(
          'BATCHALLOCATIONS.LIST',
          [
            element('GODOWNNAME', line.godownName ?? '$$Primary'),
            element('BATCHNAME', line.batchName ?? '$$Primary'),
            element('ACTUALQTY', quantity),
            element('BILLEDQTY', quantity),
            element('AMOUNT', `-${tallyAmount(line.amountMinor, line.currencyExponent)}`),
          ].join(''),
        );

  return wrap(
    'ALLINVENTORYENTRIES.LIST',
    [
      element('STOCKITEMNAME', line.stockItemName),
      element('ISDEEMEDPOSITIVE', 'No'),
      element('RATE', `${tallyAmount(line.rateMinor, line.currencyExponent)}/${line.baseUnitName}`),
      element('AMOUNT', `-${tallyAmount(line.amountMinor, line.currencyExponent)}`),
      element('ACTUALQTY', quantity),
      element('BILLEDQTY', quantity),
      // The packaging, in words, on the line it describes. A user-defined
      // field rather than a Tally-defined one, because Tally has no concept of
      // a pallet and inventing a meaning for one of its own fields would break
      // on the next build.
      line.packagingDescription === null
        ? ''
        : wrap('UDF:GLOVIAPACKAGING.LIST', element('UDF:GLOVIAPACKAGING', line.packagingDescription, { DESC: 'GloviaPackaging', ISLIST: 'Yes', TYPE: 'String', INDEX: '1' }), { DESC: 'GloviaPackaging' }),
      accounting,
      batch,
    ].join(''),
  );
}

function ledgerEntry(entry: VoucherLedgerEntry): string {
  const amount = tallyAmount(entry.amountMinor, entry.currencyExponent);

  return wrap(
    'LEDGERENTRIES.LIST',
    [
      element('LEDGERNAME', entry.ledgerName),
      element('ISDEEMEDPOSITIVE', entry.isDeemedPositive ? 'Yes' : 'No'),
      element('AMOUNT', amount),
      entry.costCentreName === null || entry.costCentreName === undefined
        ? ''
        : wrap(
            'CATEGORYALLOCATIONS.LIST',
            [
              element('CATEGORY', 'Primary Cost Category'),
              wrap(
                'COSTCENTREALLOCATIONS.LIST',
                element('NAME', entry.costCentreName) + element('AMOUNT', amount),
              ),
            ].join(''),
          ),
    ].join(''),
  );
}

// ---------------------------------------------------------------------------
// Masters
// ---------------------------------------------------------------------------

/**
 * A party ledger, for a buyer.
 *
 * ONLY sent when the seller has switched party-ledger syncing on AND allowed
 * masters to be created. Creating a ledger in somebody's accounts without
 * being asked is not a convenience - it is an unrequested change to a
 * financial record, and `autoCreateMasters` defaults to false for that reason.
 */
export function partyLedgerMaster(input: {
  name: string;
  parentGroup: string;
  /** Registration number, where the buyer has one. */
  taxRegistration?: string | null;
  countryName?: string | null;
  stateName?: string | null;
  addressLines?: readonly string[];
}): string {
  const address =
    input.addressLines === undefined || input.addressLines.length === 0
      ? ''
      : wrap(
          'ADDRESS.LIST',
          input.addressLines.slice(0, 4).map((line) => element('ADDRESS', line)).join(''),
          { TYPE: 'String' },
        );

  return wrap(
    'LEDGER',
    [
      element('NAME', input.name),
      element('PARENT', input.parentGroup),
      element('ISBILLWISEON', 'Yes'),
      input.taxRegistration === null || input.taxRegistration === undefined
        ? ''
        : element('PARTYGSTIN', input.taxRegistration),
      input.countryName === null || input.countryName === undefined
        ? ''
        : element('COUNTRYNAME', input.countryName),
      input.stateName === null || input.stateName === undefined
        ? ''
        : element('LEDSTATENAME', input.stateName),
      address,
    ].join(''),
    { NAME: input.name, ACTION: 'Create' },
  );
}

/**
 * A stock item, for one of the seller's SKUs.
 *
 * The base unit is the SKU's own unit and nothing here invents a pallet unit:
 * a compound unit is something the seller creates in Tally themselves and then
 * maps, precisely because its conversion factor becomes part of their
 * accounting and should not appear in their chart because a marketplace
 * decided it should.
 */
export function stockItemMaster(input: {
  name: string;
  parentGroup: string | null;
  baseUnitName: string;
  /** The seller's own SKU, kept as a user-defined field for reconciliation. */
  sellerSku: string | null;
}): string {
  return wrap(
    'STOCKITEM',
    [
      element('NAME', input.name),
      input.parentGroup === null ? '' : element('PARENT', input.parentGroup),
      element('BASEUNITS', input.baseUnitName),
      input.sellerSku === null
        ? ''
        : element('DESCRIPTION', `SKU ${input.sellerSku}`),
    ].join(''),
    { NAME: input.name, ACTION: 'Create' },
  );
}

/** A godown, for one of the seller's locations. */
export function godownMaster(input: { name: string; parentGroup: string | null }): string {
  return wrap(
    'GODOWN',
    [
      element('NAME', input.name),
      element('PARENT', input.parentGroup ?? '$$Primary'),
      element('HASNOSPACE', 'No'),
    ].join(''),
    { NAME: input.name, ACTION: 'Create' },
  );
}
