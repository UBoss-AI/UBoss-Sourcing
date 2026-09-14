/**
 * What the listing wizard is allowed to ask for, in one category.
 *
 * The wizard renders itself from what this returns. It has no field list of its
 * own, and that is the whole difference between a form that works for one
 * category and a marketplace: an infusion pump needs a flow rate and a
 * connector type, a surgical glove needs a size and a powder state, and neither
 * list belongs in a React component that has to be redeployed to add a field.
 *
 * INHERITANCE
 *
 * Definitions attach to a category and apply to every category beneath it.
 * "Infusion" carrying `flow_rate` means "Infusion > Volumetric Pumps" carries
 * it too, without a copy. A definition lower in the tree with the same
 * `attributeKey` replaces the one above rather than joining it, so a child can
 * tighten a parent's rule - make an optional field required, narrow its allowed
 * values - which is the only kind of override anybody has ever wanted here.
 *
 * The alternative, a row per leaf category, means adding one field to a
 * top-level category is forty edits, thirty-nine of which somebody forgets.
 */
import type { ListingSection } from '../../generated/prisma/enums.js';
import { notFound } from '../../domain/errors.js';
import type {
  AttributeDefinition,
  ListingSectionName,
  MediaSlotRequirement,
} from '../../domain/listing-completeness.js';
import type { TitleComponentDefinition } from '../../domain/listing-title.js';
import { prisma } from '../../infra/prisma.js';

/** One attribute, as the wizard needs it. */
export interface SchemaAttribute extends AttributeDefinition {
  helpText: string | null;
  sortOrder: number;
  isSearchable: boolean;
  isVariantDimension: boolean;
  isTitleComponent: boolean;
  titleOrder: number | null;
  /**
   * Whether this definition applies to every category rather than to this one.
   *
   * The one thing that makes isRegulatedCategory answerable. A marketplace
   * sells fasteners and infusion pumps out of the same catalogue, so 'is this
   * a regulated product' cannot be 'does the schema mention a UDI' - a UDI
   * field defined globally would make a box of washers a medical device.
   * A category is regulated when a regulatory field reaches it from a
   * definition attached to a CATEGORY, which is a decision somebody made about
   * that category.
   */
  isGlobal: boolean;
}

export interface ListingSchema {
  categoryId: string;
  categoryName: string;
  /** Root to leaf, for the breadcrumb the wizard shows above the form. */
  categoryPath: { id: string; name: string }[];
  attributes: SchemaAttribute[];
  mediaSlots: MediaSlotRequirement[];
  /** Which attributes a seller may use to split this listing into variants. */
  variantDimensions: { attributeKey: string; label: string }[];
  /** Per-section counts of what is required, so the wizard can show them before
   * the seller has typed anything. */
  sectionTotals: { section: ListingSectionName; total: number; required: number }[];
}

/**
 * The image slots every product has, in the order the reference screens show
 * them.
 *
 * The LIST is code and the REQUIRED FLAG is data: which slots a category
 * demands is a business decision that differs between a sterile implant and a
 * bag of screws, but the vocabulary of slots is fixed, because a moderator
 * checking "is there a readable UDI label" has to know which image claims to be
 * one.
 *
 * Held here rather than in `ListingMediaSlot` alone because the enum carries no
 * label and no order, and both are needed to render the strip.
 */
const MEDIA_SLOT_LABELS: readonly { slot: string; label: string }[] = Object.freeze([
  { slot: 'FRONT_VIEW', label: 'Front view' },
  { slot: 'BACK_VIEW', label: 'Back view' },
  { slot: 'SIDE_VIEW', label: 'Side view' },
  { slot: 'PACKAGING', label: 'Packaging' },
  { slot: 'PRODUCT_LABEL', label: 'Product label' },
  { slot: 'UDI_LABEL', label: 'UDI or GTIN label' },
  { slot: 'DIMENSIONS_REFERENCE', label: 'Dimensions or size reference' },
  { slot: 'CONNECTOR_VIEW', label: 'Connector or component view' },
  { slot: 'STERILE_SEAL', label: 'Sterile seal' },
  { slot: 'INSTRUCTIONS_VIEW', label: 'Instructions or usage view' },
]);

/**
 * Slots every listing must fill, whatever the category.
 *
 * Two, and only two. A front view because a buyer will not order something they
 * cannot see, and the packaging because a B2B buyer is ordering a box and needs
 * to know what arrives. Everything else is category-driven, because demanding a
 * sterile-seal photograph of a non-sterile product is how a seller learns to
 * upload the same picture ten times.
 */
const ALWAYS_REQUIRED_SLOTS = new Set(['FRONT_VIEW', 'PACKAGING']);

/**
 * Extra slots a category demands, keyed by an attribute the category carries.
 *
 * Derived rather than configured: a category that ASKS for a UDI is a category
 * of regulated devices, and a regulated device has to show its UDI label. Tying
 * the photograph to the field means an operator adding the field gets the
 * photograph requirement without having to know it exists.
 *
 * Only category-scoped definitions count - see `isGlobal`. A marketplace that
 * sells fasteners as well as infusion pumps must not demand a sterile-seal
 * photograph of a box of washers.
 */
const SLOT_IMPLIED_BY_ATTRIBUTE: Readonly<Record<string, string>> = Object.freeze({
  udi_di: 'UDI_LABEL',
  gtin: 'UDI_LABEL',
  sterile_status: 'STERILE_SEAL',
  connector_type: 'CONNECTOR_VIEW',
});

function toSectionName(section: ListingSection): ListingSectionName {
  return section;
}

/** Ancestors of a category, root first, including the category itself. */
async function categoryChain(categoryId: string): Promise<{ id: string; name: string }[]> {
  const chain: { id: string; name: string }[] = [];
  let current: string | null = categoryId;

  // Bounded rather than "until parentId is null". `Category` is a tree with a
  // self-relation and nothing at the database level forbids a cycle; an
  // unbounded walk over one hangs the request rather than failing it.
  for (let depth = 0; depth < 12 && current !== null; depth += 1) {
    const row: { id: string; name: string; parentId: string | null } | null =
      await prisma.category.findUnique({
        where: { id: current },
        select: { id: true, name: true, parentId: true },
      });

    if (row === null) break;

    chain.unshift({ id: row.id, name: row.name });
    current = row.parentId;
  }

  return chain;
}

/**
 * Every field this category asks for, with inheritance resolved.
 *
 * Global definitions (`categoryKey` = '*') come first and are overridden by
 * anything more specific, ancestors before descendants.
 */
export async function loadListingSchema(categoryId: string): Promise<ListingSchema> {
  const chain = await categoryChain(categoryId);

  if (chain.length === 0) throw notFound('Category');

  const chainIds = chain.map((entry) => entry.id);

  const rows = await prisma.categoryAttributeDefinition.findMany({
    where: {
      isActive: true,
      OR: [{ categoryKey: '*' }, { categoryId: { in: chainIds } }],
    },
    orderBy: [{ sortOrder: 'asc' }, { attributeKey: 'asc' }],
  });

  // Depth of each category in the chain, so a definition on a child beats one
  // on its parent regardless of the order the rows came back in.
  const depthOf = new Map<string, number>(chainIds.map((id, index) => [id, index + 1]));

  const winning = new Map<string, { depth: number; row: (typeof rows)[number] }>();

  for (const row of rows) {
    const depth = row.categoryId === null ? 0 : (depthOf.get(row.categoryId) ?? -1);
    if (depth < 0) continue;

    const existing = winning.get(row.attributeKey);
    if (existing === undefined || depth >= existing.depth) {
      winning.set(row.attributeKey, { depth, row });
    }
  }

  const attributes: SchemaAttribute[] = [...winning.values()]
    .map(({ row }) => ({
      attributeKey: row.attributeKey,
      label: row.label,
      helpText: row.helpText,
      section: toSectionName(row.section),
      type: row.type,
      isRequired: row.isRequired,
      unit: row.unit,
      allowedUnits: Array.isArray(row.allowedUnitsJson)
        ? (row.allowedUnitsJson as string[])
        : null,
      allowedValues: Array.isArray(row.allowedValuesJson)
        ? (row.allowedValuesJson as { value: string; label: string }[])
        : null,
      minNumber: row.minNumber === null ? null : Number(row.minNumber),
      maxNumber: row.maxNumber === null ? null : Number(row.maxNumber),
      minLength: row.minLength,
      maxLength: row.maxLength,
      pattern: row.pattern,
      isSearchable: row.isSearchable,
      isVariantDimension: row.isVariantDimension,
      isTitleComponent: row.isTitleComponent,
      titleOrder: row.titleOrder,
      isRegulatoryOnly: row.isRegulatoryOnly,
      isGlobal: row.categoryId === null,
      sortOrder: row.sortOrder,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.attributeKey.localeCompare(b.attributeKey));

  // Only from CATEGORY-scoped definitions, for the same reason
  //  looks at those: a globally defined GTIN field must
  // not demand a barcode photograph of every product in the marketplace.
  const scopedKeys = new Set(
    attributes.filter((attribute) => !attribute.isGlobal).map((attribute) => attribute.attributeKey),
  );

  const impliedSlots = new Set<string>();
  for (const [attributeKey, slot] of Object.entries(SLOT_IMPLIED_BY_ATTRIBUTE)) {
    if (scopedKeys.has(attributeKey)) impliedSlots.add(slot);
  }

  const mediaSlots: MediaSlotRequirement[] = MEDIA_SLOT_LABELS.map((entry) => ({
    slot: entry.slot,
    label: entry.label,
    isRequired: ALWAYS_REQUIRED_SLOTS.has(entry.slot) || impliedSlots.has(entry.slot),
  }));

  const sectionTotals = (
    ['PRODUCT_PHOTOS', 'PRICE_STOCK_SHIPPING', 'PRODUCT_DESCRIPTION', 'ADDITIONAL_INFORMATION', 'MEDICAL_COMPLIANCE'] as const
  ).map((section) => {
    if (section === 'PRODUCT_PHOTOS') {
      return {
        section,
        total: mediaSlots.length,
        required: mediaSlots.filter((slot) => slot.isRequired).length,
      };
    }

    const inSection = attributes.filter((attribute) => attribute.section === section);
    return {
      section,
      total: inSection.length,
      required: inSection.filter((attribute) => attribute.isRequired).length,
    };
  });

  const leaf = chain[chain.length - 1];

  return {
    categoryId: leaf?.id ?? categoryId,
    categoryName: leaf?.name ?? '',
    categoryPath: chain,
    attributes,
    mediaSlots,
    variantDimensions: attributes
      .filter((attribute) => attribute.isVariantDimension)
      .map((attribute) => ({ attributeKey: attribute.attributeKey, label: attribute.label })),
    sectionTotals,
  };
}

/** The title components of a schema, ready for `generateTitle`. */
export function titleComponents(schema: ListingSchema): TitleComponentDefinition[] {
  return schema.attributes
    .filter(
      (attribute): attribute is SchemaAttribute & { titleOrder: number } =>
        attribute.isTitleComponent && attribute.titleOrder !== null,
    )
    .map((attribute) => ({ ...attribute, titleOrder: attribute.titleOrder }));
}

/**
 * Does this category describe regulated medical devices?
 *
 * Answered from the schema rather than from a flag on the category, because the
 * fact that decides it is already there: a category asking for a UDI, a device
 * class or a CE marking is a category of regulated devices. One fewer column to
 * keep in step with the fields it is supposed to describe.
 */
export function isRegulatedCategory(schema: ListingSchema): boolean {
  return schema.attributes.some(
    (attribute) => attribute.isRegulatoryOnly === true && !attribute.isGlobal,
  );
}
