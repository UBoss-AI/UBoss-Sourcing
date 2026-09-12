/**
 * "Does my system and this one hold the same products?"
 *
 * The question every buyer asks within a day of connecting, and the one the
 * rest of this feature answered only by implication: the sync log says "read
 * 736 records and recorded 1", which is accurate and tells nobody WHICH one, or
 * why the other 735 went nowhere.
 *
 * The answer is three lists, and the middle one is the whole point:
 *
 *   - **In both** - a product here whose SKU was found in their system. These
 *     are the ones the integration can actually act on.
 *   - **Only in their system** - a code their ERP sent that matches no product
 *     here. Usually not an error: their ERP holds their whole catalogue and we
 *     hold the part they buy from this store.
 *   - **Only here** - a product in this store's catalogue that their ERP has
 *     never mentioned. This is the one that costs money, because it is the
 *     product whose stock figure will never be updated and nobody would notice.
 *
 * WHY THIS IS A LIVE READ AND NOT A STORED REPORT
 *
 * The matched set is in the database already - `customer_erp_inventory_links` is
 * exactly that. The other two are not: nothing stores the codes that did NOT
 * match, and adding a table for them would mean a schema carrying a copy of
 * somebody else's catalogue, kept up to date, for a screen looked at
 * occasionally. So this walks their feed when asked, through the same connector
 * the sync uses, and compares in memory. It costs what one sync pass costs and
 * happens only when a person presses a button.
 *
 * MATCHING IS ON SKU, EXACTLY
 *
 * Not case-folded, not trimmed of punctuation, not fuzzy. `FG/1BZ1B1-G` and
 * `EV-CANNULA-WP` are different products until somebody says otherwise, and a
 * reconciliation that guessed would be worse than one that reports the gap: it
 * would attach a stock figure to the wrong item and be believed.
 */
import { env } from '../../config/env.js';
import { prisma } from '../../infra/prisma.js';
import { loadConnectorContext } from './connectors/index.js';
import { assertCapability, type Membership } from './organization.service.js';

/** A ceiling on one pass, the same one the poller holds itself to. */
const MAX_PAGES = 50;

/** How many of each list to name. The counts are always complete. */
const SAMPLE_LIMIT = 100;

export interface ReconciliationRow {
  /** Their code. For a matched row this equals `sku`. */
  erpCode: string;
  /** Our SKU, where we have the product. */
  sku: string | null;
  /** Our product name, where we have the product. */
  productName: string | null;
  /** What their system says it holds, where it said anything. */
  onHandQty: number | null;
  lastSyncedAt: string | null;
}

export interface Reconciliation {
  checkedAt: string;
  /** Distinct codes their system returned. */
  erpCodeCount: number;
  /** Products in this store's catalogue. */
  catalogueCount: number;
  inBoth: { count: number; rows: ReconciliationRow[] };
  onlyInErp: { count: number; rows: ReconciliationRow[] };
  onlyHere: { count: number; rows: ReconciliationRow[] };
  /**
   * True when their feed was longer than one pass may read, so the two
   * "only in..." lists are provisional. Said out loud rather than rounded away:
   * a partial read makes matched products look unmatched, which is the one
   * wrong conclusion this screen could lead somebody to.
   */
  truncated: boolean;
}

/**
 * Walk their system, compare against ours, and report the three sets.
 *
 * `OPERATE` rather than `CONFIGURE`: this reads and changes nothing, and the
 * person who needs it is whoever is chasing a stock figure, not whoever set the
 * connection up.
 */
export async function reconcile(
  membership: Membership,
  connectionId: string,
): Promise<Reconciliation> {
  assertCapability(membership, 'OPERATE');

  const connection = await prisma.customerErpConnection.findFirstOrThrow({
    where: { id: connectionId, organizationId: membership.organizationId, deletedAt: null },
  });

  const { connector, context } = await loadConnectorContext({
    connectionId: connection.id,
    organizationId: connection.organizationId,
  });

  // Their side, through the connector the sync uses - so what this screen
  // compares is what the sync would actually see, not a second reading of it.
  const erp = new Map<string, number | null>();
  let cursor: string | null = null;
  let read = 0;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await connector.readInventory(context, cursor);

    for (const record of result.records) {
      read += 1;
      if (record.sku === null) continue;
      // First mention wins. A feed that lists a code twice is describing one
      // product, and the second row is not a second product.
      if (!erp.has(record.sku)) erp.set(record.sku, record.onHandQty);
    }

    cursor = result.nextCursor;

    if (cursor === null) break;

    if (read >= env.CUSTOMER_ERP_MAX_SYNC_RECORDS || page === MAX_PAGES - 1) {
      truncated = true;
      break;
    }
  }

  // Our side. The whole catalogue, because "only here" is the list this is for
  // and it cannot be computed from a page of it.
  const products = await prisma.product.findMany({
    select: { id: true, sku: true, name: true },
    orderBy: { name: 'asc' },
  });

  const links = await prisma.customerErpInventoryLink.findMany({
    where: { connectionId, organizationId: membership.organizationId },
    select: { productId: true, onHandQty: true, lastSyncedAt: true },
  });

  const linkByProduct = new Map(links.map((row) => [row.productId, row]));

  const inBoth: ReconciliationRow[] = [];
  const onlyHere: ReconciliationRow[] = [];
  const seen = new Set<string>();

  for (const product of products) {
    if (erp.has(product.sku)) {
      seen.add(product.sku);
      const link = linkByProduct.get(product.id);

      inBoth.push({
        erpCode: product.sku,
        sku: product.sku,
        productName: product.name,
        onHandQty: erp.get(product.sku) ?? null,
        lastSyncedAt: link?.lastSyncedAt?.toISOString() ?? null,
      });
      continue;
    }

    onlyHere.push({
      erpCode: product.sku,
      sku: product.sku,
      productName: product.name,
      onHandQty: null,
      lastSyncedAt: null,
    });
  }

  const onlyInErp: ReconciliationRow[] = [];
  for (const [code, qty] of erp) {
    if (seen.has(code)) continue;
    onlyInErp.push({
      erpCode: code,
      sku: null,
      productName: null,
      onHandQty: qty,
      lastSyncedAt: null,
    });
  }

  return {
    checkedAt: new Date().toISOString(),
    erpCodeCount: erp.size,
    catalogueCount: products.length,
    inBoth: { count: inBoth.length, rows: inBoth.slice(0, SAMPLE_LIMIT) },
    onlyInErp: { count: onlyInErp.length, rows: onlyInErp.slice(0, SAMPLE_LIMIT) },
    onlyHere: { count: onlyHere.length, rows: onlyHere.slice(0, SAMPLE_LIMIT) },
    truncated,
  };
}
