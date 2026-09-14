/**
 * Seed for the Seller Hub: what the listing wizard asks for, and what each
 * country demands of a seller.
 *
 * These are DEFAULTS, not constants. Every row here is editable by the operator
 * afterwards, and that is the point of seeding them rather than hard-coding
 * them: a deployment in Germany will delete the GSTIN rule and keep the VAT
 * one, a deployment selling only packaging will delete the medical ones
 * entirely. Seeding gives them somewhere to start; the table is what makes it
 * theirs.
 *
 * The marketplace is GENERAL. A seller here lists fasteners, cables, packaging
 * or infusion pumps, so what every seller is asked is deliberately short and
 * everything specific to a trade hangs off the CATEGORY that sells it.
 *
 * Idempotent throughout, like the rest of the seed: it upserts by the natural
 * key so running it twice changes nothing and running it after an operator has
 * edited a row leaves their edit alone where the key matches.
 */
import { newId } from '../infra/ids.js';
import { prisma } from '../infra/prisma.js';

// ---------------------------------------------------------------------------
// What a country asks of a seller
// ---------------------------------------------------------------------------

interface RequirementSeed {
  /** ISO-3166-1 alpha-2, or '*' for every country. */
  countryKey: string;
  stepKey: string;
  fieldKey: string;
  label: string;
  helpText?: string;
  isRequired?: boolean;
  isDocument?: boolean;
  validationPattern?: string;
  appliesToKind?: 'MANUFACTURER' | 'AUTHORISED_DISTRIBUTOR' | 'WHOLESALER' | 'RESELLER';
  sortOrder?: number;
}

const REQUIREMENTS: readonly RequirementSeed[] = Object.freeze([
  // --- Everywhere --------------------------------------------------------
  {
    countryKey: '*',
    stepKey: 'business_identity',
    fieldKey: 'company_registration_number',
    label: 'Company registration number',
    helpText: 'The number your business is registered under in its home country.',
    sortOrder: 10,
  },
  {
    countryKey: '*',
    stepKey: 'business_identity',
    fieldKey: 'tax_registration_number',
    label: 'Tax registration number',
    helpText: 'VAT, GST or the equivalent where your business is registered.',
    sortOrder: 20,
  },
  {
    countryKey: '*',
    stepKey: 'business_identity',
    fieldKey: 'registered_address',
    label: 'Registered address',
    sortOrder: 30,
  },
  {
    countryKey: '*',
    stepKey: 'business_identity',
    fieldKey: 'website_url',
    label: 'Business website',
    isRequired: false,
    sortOrder: 40,
  },
  {
    countryKey: '*',
    stepKey: 'kyb_kyc',
    fieldKey: 'representative_name',
    label: 'Authorised representative',
    helpText: 'The person who can sign for the business.',
    sortOrder: 10,
  },
  {
    countryKey: '*',
    stepKey: 'kyb_kyc',
    fieldKey: 'representative_email',
    label: 'Representative email address',
    sortOrder: 20,
  },
  {
    countryKey: '*',
    stepKey: 'kyb_kyc',
    fieldKey: 'business_registration_document',
    label: 'Business registration document',
    helpText: 'A certificate of incorporation, trade register extract or equivalent.',
    isDocument: true,
    sortOrder: 30,
  },
  {
    countryKey: '*',
    stepKey: 'kyb_kyc',
    fieldKey: 'identity_proof',
    label: 'Photo identification for the representative',
    isDocument: true,
    sortOrder: 40,
  },

  // --- Compliance ---------------------------------------------------------
  //
  // NOTHING HERE IS REQUIRED BY DEFAULT, and that is the decision that makes
  // this a general marketplace rather than a medical one. A seller listing
  // cable ties has no ISO 13485 certificate and never will; demanding one to
  // finish an application would stop them selling anything at all.
  //
  // What the operator does instead is turn these on for the trades they
  // actually regulate - which is one edit per row, in a table, per deployment.
  // The product-level regulatory questions are already handled properly, per
  // CATEGORY, by `CATEGORY_ATTRIBUTE_SETS`: a seller listing an infusion pump
  // is asked for a device class because the CATEGORY asks, not because every
  // seller on the marketplace was asked up front.
  //
  // The split by seller kind is the interesting part of what remains. A
  // manufacturer signs its own Declaration of Conformity; a distributor cannot,
  // and asking them for one produces either a forged document or a support
  // ticket. What a distributor needs instead is proof that whoever does make it
  // authorised them to sell it.
  {
    countryKey: '*',
    stepKey: 'compliance',
    fieldKey: 'quality_certificate',
    label: 'Quality management certificate',
    helpText:
      'ISO 9001, ISO 13485 or the equivalent for what you sell. Optional unless the ' +
      'marketplace requires it for your trade.',
    isDocument: true,
    isRequired: false,
    sortOrder: 10,
  },
  {
    countryKey: '*',
    stepKey: 'compliance',
    fieldKey: 'declaration_of_conformity',
    label: 'Declaration of Conformity',
    helpText: 'For each product family you intend to list that carries one.',
    isDocument: true,
    isRequired: false,
    appliesToKind: 'MANUFACTURER',
    sortOrder: 20,
  },
  {
    countryKey: '*',
    stepKey: 'compliance',
    fieldKey: 'distribution_authorisation',
    label: 'Authorisation from the manufacturer',
    helpText: 'Written evidence that you are entitled to sell the brands you have claimed.',
    isDocument: true,
    isRequired: false,
    appliesToKind: 'AUTHORISED_DISTRIBUTOR',
    sortOrder: 30,
  },

  // --- European Union -----------------------------------------------------
  //
  // Country rows OVERRIDE the global row with the same field key rather than
  // adding to it - see `requirementsFor`. So "tax_registration_number" here
  // replaces the generic label with the VAT-specific one and its format.
  {
    countryKey: 'DE',
    stepKey: 'business_identity',
    fieldKey: 'tax_registration_number',
    label: 'VAT identification number (USt-IdNr.)',
    helpText: 'Including the DE prefix, e.g. DE123456789.',
    validationPattern: '^DE[0-9]{9}$',
    sortOrder: 20,
  },
  {
    countryKey: 'NL',
    stepKey: 'business_identity',
    fieldKey: 'tax_registration_number',
    label: 'VAT identification number (btw-id)',
    validationPattern: '^NL[0-9]{9}B[0-9]{2}$',
    sortOrder: 20,
  },
  {
    countryKey: 'FR',
    stepKey: 'business_identity',
    fieldKey: 'tax_registration_number',
    label: 'VAT identification number (numéro de TVA)',
    validationPattern: '^FR[0-9A-Z]{2}[0-9]{9}$',
    sortOrder: 20,
  },
  {
    countryKey: 'DE',
    stepKey: 'business_identity',
    fieldKey: 'eori_number',
    label: 'EORI number',
    helpText: 'Needed if you ship goods across an EU external border.',
    isRequired: false,
    sortOrder: 25,
  },
  {
    countryKey: 'DE',
    stepKey: 'compliance',
    fieldKey: 'eudamed_srn',
    label: 'EUDAMED Single Registration Number',
    helpText: 'Your SRN as an economic operator under the MDR or IVDR.',
    isRequired: false,
    sortOrder: 15,
  },

  // --- India --------------------------------------------------------------
  //
  // Present as ONE COUNTRY'S RULES, which is the whole point. Nothing in the
  // application code knows what a GSTIN is; it is a row here with a pattern,
  // and a deployment that never sells in India simply never reads it.
  {
    countryKey: 'IN',
    stepKey: 'business_identity',
    fieldKey: 'tax_registration_number',
    label: 'GSTIN',
    helpText: 'Your 15-character Goods and Services Tax identification number.',
    validationPattern: '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$',
    sortOrder: 20,
  },
  {
    countryKey: 'IN',
    stepKey: 'kyb_kyc',
    fieldKey: 'pan_number',
    label: 'PAN',
    helpText: 'The permanent account number of the business.',
    validationPattern: '^[A-Z]{5}[0-9]{4}[A-Z]$',
    sortOrder: 25,
  },
  {
    countryKey: 'IN',
    stepKey: 'compliance',
    fieldKey: 'cdsco_licence',
    label: 'CDSCO import or manufacturing licence',
    helpText: 'Where what you list is notified under the Medical Devices Rules.',
    isDocument: true,
    isRequired: false,
    sortOrder: 30,
  },
]);

// ---------------------------------------------------------------------------
// What the listing wizard asks for
// ---------------------------------------------------------------------------

interface AttributeSeed {
  attributeKey: string;
  label: string;
  helpText?: string;
  section:
    | 'PRODUCT_PHOTOS'
    | 'PRICE_STOCK_SHIPPING'
    | 'PRODUCT_DESCRIPTION'
    | 'ADDITIONAL_INFORMATION'
    | 'MEDICAL_COMPLIANCE';
  type:
    | 'TEXT'
    | 'LONG_TEXT'
    | 'RICH_TEXT'
    | 'NUMBER'
    | 'DECIMAL'
    | 'MEASUREMENT'
    | 'DROPDOWN'
    | 'MULTI_SELECT'
    | 'BOOLEAN'
    | 'DATE'
    | 'KEY_VALUE_LIST'
    | 'DOCUMENT';
  isRequired?: boolean;
  unit?: string;
  allowedUnits?: string[];
  allowedValues?: { value: string; label: string }[];
  minNumber?: number;
  maxNumber?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  isSearchable?: boolean;
  isVariantDimension?: boolean;
  isTitleComponent?: boolean;
  titleOrder?: number;
  isRegulatoryOnly?: boolean;
  sortOrder: number;
}

/**
 * The fields EVERY product carries, whatever it is.
 *
 * Seeded against `categoryKey = '*'`, so they are inherited by every category
 * and an operator adding a new one gets a usable wizard without doing anything.
 *
 * This list is deliberately GENERIC. A marketplace sells fasteners, cables,
 * packaging and infusion pumps out of one catalogue, and a global field list
 * that asked every seller for a device class would make listing a box of
 * washers absurd. Anything that belongs to a kind of product - a device class,
 * a sterilisation method, a voltage, a thread pitch - is attached to the
 * CATEGORY it belongs to instead. See `CATEGORY_ATTRIBUTE_SETS` below.
 *
 * The `isTitleComponent` set is the one to read carefully: these, in
 * `titleOrder`, are what the generated product title is built from. Adding a
 * field to that set changes the title of every listing made afterwards, which
 * is why it is a deliberate short list rather than "everything that looks
 * important".
 */
const GLOBAL_ATTRIBUTES: readonly AttributeSeed[] = Object.freeze([
  // --- Description --------------------------------------------------------
  {
    attributeKey: 'generic_name',
    label: 'Product name',
    helpText: 'What the item is, generically — "M6 hex bolt", "USB-C cable", "Nitrile glove".',
    section: 'PRODUCT_DESCRIPTION',
    type: 'TEXT',
    isRequired: true,
    minLength: 3,
    maxLength: 160,
    isSearchable: true,
    isTitleComponent: true,
    titleOrder: 10,
    sortOrder: 10,
  },
  {
    attributeKey: 'model_number',
    label: 'Model or part number',
    helpText: "The manufacturer's own reference for this exact item.",
    section: 'PRODUCT_DESCRIPTION',
    type: 'TEXT',
    isRequired: true,
    maxLength: 64,
    isSearchable: true,
    isTitleComponent: true,
    titleOrder: 20,
    sortOrder: 20,
  },
  {
    attributeKey: 'short_description',
    label: 'Summary',
    helpText: 'One or two sentences. This is what a buyer sees in a list of results.',
    section: 'PRODUCT_DESCRIPTION',
    type: 'LONG_TEXT',
    isRequired: true,
    minLength: 20,
    maxLength: 1024,
    sortOrder: 30,
  },
  {
    attributeKey: 'description',
    label: 'Full description',
    section: 'PRODUCT_DESCRIPTION',
    type: 'RICH_TEXT',
    isRequired: true,
    minLength: 40,
    maxLength: 20000,
    sortOrder: 40,
  },
  {
    attributeKey: 'material',
    label: 'Material',
    section: 'PRODUCT_DESCRIPTION',
    type: 'TEXT',
    maxLength: 160,
    isSearchable: true,
    isTitleComponent: true,
    titleOrder: 40,
    sortOrder: 60,
  },
  {
    attributeKey: 'size',
    label: 'Size',
    helpText: 'The size as it is printed on the product or its packaging.',
    section: 'PRODUCT_DESCRIPTION',
    type: 'TEXT',
    maxLength: 48,
    isSearchable: true,
    // A variant dimension: the same glove in S, M and L is one product with
    // three variants, not three products.
    isVariantDimension: true,
    isTitleComponent: true,
    titleOrder: 50,
    sortOrder: 70,
  },
  {
    attributeKey: 'colour',
    label: 'Colour',
    section: 'PRODUCT_DESCRIPTION',
    type: 'TEXT',
    maxLength: 48,
    isVariantDimension: true,
    sortOrder: 80,
  },
  {
    attributeKey: 'condition',
    label: 'Condition',
    section: 'PRODUCT_DESCRIPTION',
    type: 'DROPDOWN',
    isRequired: true,
    allowedValues: [
      { value: 'new', label: 'New' },
      { value: 'refurbished', label: 'Refurbished' },
      { value: 'used', label: 'Used' },
    ],
    isSearchable: true,
    sortOrder: 90,
  },

  // --- Additional information ---------------------------------------------
  {
    attributeKey: 'package_contents',
    label: 'In the box',
    helpText: 'Each item that arrives, with how many of it.',
    section: 'ADDITIONAL_INFORMATION',
    type: 'KEY_VALUE_LIST',
    sortOrder: 10,
  },
  {
    attributeKey: 'country_of_origin',
    label: 'Country of origin',
    section: 'ADDITIONAL_INFORMATION',
    type: 'TEXT',
    maxLength: 64,
    isSearchable: true,
    sortOrder: 20,
  },
  {
    attributeKey: 'storage_requirements',
    label: 'Storage or handling notes',
    helpText: 'Anything that affects how it is kept — temperature, humidity, upright only.',
    section: 'ADDITIONAL_INFORMATION',
    type: 'LONG_TEXT',
    maxLength: 1000,
    sortOrder: 30,
  },
  {
    attributeKey: 'shelf_life_months',
    label: 'Shelf life',
    helpText: 'Leave blank for anything that does not expire.',
    section: 'ADDITIONAL_INFORMATION',
    type: 'NUMBER',
    unit: 'months',
    minNumber: 0,
    maxNumber: 600,
    sortOrder: 40,
  },
  {
    attributeKey: 'weight_grams',
    label: 'Unit weight',
    section: 'ADDITIONAL_INFORMATION',
    type: 'NUMBER',
    unit: 'g',
    minNumber: 0,
    sortOrder: 50,
  },
  {
    attributeKey: 'dimensions',
    label: 'Product dimensions',
    section: 'ADDITIONAL_INFORMATION',
    type: 'MEASUREMENT',
    allowedUnits: ['mm', 'cm', 'm'],
    sortOrder: 60,
  },
  {
    attributeKey: 'warranty_months',
    label: 'Warranty',
    section: 'ADDITIONAL_INFORMATION',
    type: 'NUMBER',
    unit: 'months',
    minNumber: 0,
    maxNumber: 600,
    sortOrder: 65,
  },
  {
    attributeKey: 'instructions_for_use',
    label: 'Manual or instructions',
    helpText: 'A PDF, where the product has one.',
    section: 'ADDITIONAL_INFORMATION',
    type: 'DOCUMENT',
    sortOrder: 70,
  },

  // --- Compliance ---------------------------------------------------------
  //
  // Two fields, and both apply to ordinary goods. A GTIN is a barcode, not a
  // medical identifier, and hazardous-goods status decides whether something
  // can go on a plane whether it is a reagent or a tin of paint.
  //
  // Everything a REGULATOR demands - device classes, CE marking, notified
  // bodies - lives on the categories that are actually regulated.
  {
    attributeKey: 'gtin',
    label: 'Barcode (GTIN / EAN / UPC)',
    helpText: '8, 12, 13 or 14 digits, exactly as printed on the barcode.',
    section: 'MEDICAL_COMPLIANCE',
    type: 'TEXT',
    // Length-checked rather than check-digit-verified here. A wrong check digit
    // is caught by the automated quality checks, where it can be explained;
    // refusing it in the form with "invalid format" tells the seller nothing.
    pattern: '^[0-9]{8}$|^[0-9]{12,14}$',
    isSearchable: true,
    sortOrder: 10,
  },
  {
    attributeKey: 'dangerous_goods',
    label: 'Restricted or dangerous goods',
    helpText: 'Batteries, aerosols, flammables, pressurised containers, corrosives.',
    section: 'MEDICAL_COMPLIANCE',
    type: 'BOOLEAN',
    sortOrder: 20,
  },
]);

/**
 * Fields that belong to a KIND of product, attached to the category that sells
 * it.
 *
 * This is the half of the seed that makes the marketplace general. A seller
 * listing an infusion pump is asked for a device class and a UDI; a seller
 * listing a hex bolt is asked for a thread size and a tensile grade; neither
 * is asked for the other's fields, and neither list is in a React component.
 *
 * Matched to categories by slug, and silently skipped where a deployment has
 * no such category - a marketplace selling only packaging simply never seeds
 * the medical set.
 */
interface CategoryAttributeSet {
  /** Root category slugs this set attaches to. */
  categorySlugs: readonly string[];
  attributes: readonly AttributeSeed[];
}

const CATEGORY_ATTRIBUTE_SETS: readonly CategoryAttributeSet[] = Object.freeze([
  // --- Medical devices ----------------------------------------------------
  //
  // `isRegulatoryOnly` on the device fields, and attached to a CATEGORY rather
  // than globally - which together are what make `isRegulatedCategory` true
  // here and false for fasteners. See `listing-schema.service.ts`.
  {
    categorySlugs: ['medical-devices'],
    attributes: [
      {
        attributeKey: 'device_class',
        label: 'Device class',
        helpText: 'Under the MDR, the IVDR or your own regulator.',
        section: 'MEDICAL_COMPLIANCE',
        type: 'DROPDOWN',
        isRequired: true,
        allowedValues: [
          { value: 'I', label: 'Class I' },
          { value: 'IIa', label: 'Class IIa' },
          { value: 'IIb', label: 'Class IIb' },
          { value: 'III', label: 'Class III' },
          { value: 'IVD_A', label: 'IVD Class A' },
          { value: 'IVD_B', label: 'IVD Class B' },
          { value: 'IVD_C', label: 'IVD Class C' },
          { value: 'IVD_D', label: 'IVD Class D' },
          { value: 'NOT_A_DEVICE', label: 'Not a medical device' },
        ],
        isSearchable: true,
        isRegulatoryOnly: true,
        sortOrder: 30,
      },
      {
        attributeKey: 'udi_di',
        label: 'UDI-DI',
        helpText: 'The device identifier part of the Unique Device Identification.',
        section: 'MEDICAL_COMPLIANCE',
        type: 'TEXT',
        maxLength: 64,
        isSearchable: true,
        isRegulatoryOnly: true,
        sortOrder: 40,
      },
      {
        attributeKey: 'ce_marking',
        label: 'CE marked',
        section: 'MEDICAL_COMPLIANCE',
        type: 'BOOLEAN',
        isRegulatoryOnly: true,
        sortOrder: 50,
      },
      {
        attributeKey: 'notified_body_number',
        label: 'Notified body number',
        helpText: 'The four-digit number beside the CE mark, where there is one.',
        section: 'MEDICAL_COMPLIANCE',
        type: 'TEXT',
        pattern: '^[0-9]{4}$',
        isRegulatoryOnly: true,
        sortOrder: 60,
      },
      {
        attributeKey: 'sterile_status',
        label: 'Supplied sterile',
        section: 'MEDICAL_COMPLIANCE',
        type: 'BOOLEAN',
        isSearchable: true,
        isTitleComponent: true,
        titleOrder: 60,
        isRegulatoryOnly: true,
        sortOrder: 70,
      },
      {
        attributeKey: 'sterilisation_method',
        label: 'Sterilisation method',
        section: 'MEDICAL_COMPLIANCE',
        type: 'DROPDOWN',
        allowedValues: [
          { value: 'eo', label: 'Ethylene oxide' },
          { value: 'gamma', label: 'Gamma irradiation' },
          { value: 'ebeam', label: 'Electron beam' },
          { value: 'steam', label: 'Steam' },
          { value: 'none', label: 'Not sterilised' },
        ],
        isRegulatoryOnly: true,
        sortOrder: 80,
      },
      {
        attributeKey: 'single_use',
        label: 'Single use only',
        section: 'MEDICAL_COMPLIANCE',
        type: 'BOOLEAN',
        isSearchable: true,
        sortOrder: 90,
      },
      {
        attributeKey: 'latex_free',
        label: 'Latex free',
        section: 'MEDICAL_COMPLIANCE',
        type: 'BOOLEAN',
        isSearchable: true,
        sortOrder: 100,
      },
      {
        attributeKey: 'intended_use',
        label: 'Intended use',
        helpText: 'What the device is for, in the words the manufacturer uses.',
        section: 'PRODUCT_DESCRIPTION',
        type: 'LONG_TEXT',
        isRequired: true,
        minLength: 20,
        maxLength: 2000,
        sortOrder: 35,
      },
      {
        attributeKey: 'medical_speciality',
        label: 'Medical speciality',
        section: 'PRODUCT_DESCRIPTION',
        type: 'MULTI_SELECT',
        allowedValues: [
          { value: 'anaesthesia', label: 'Anaesthesia' },
          { value: 'cardiology', label: 'Cardiology' },
          { value: 'dental', label: 'Dental' },
          { value: 'diagnostics', label: 'Diagnostics' },
          { value: 'emergency', label: 'Emergency and ambulance' },
          { value: 'general_surgery', label: 'General surgery' },
          { value: 'infection_control', label: 'Infection control' },
          { value: 'laboratory', label: 'Laboratory' },
          { value: 'orthopaedics', label: 'Orthopaedics' },
          { value: 'respiratory', label: 'Respiratory' },
          { value: 'wound_care', label: 'Wound care' },
        ],
        isSearchable: true,
        sortOrder: 50,
      },
    ],
  },

  // --- Electrical and electronics -----------------------------------------
  {
    categorySlugs: ['electrical', 'apple'],
    attributes: [
      {
        attributeKey: 'voltage',
        label: 'Voltage',
        section: 'PRODUCT_DESCRIPTION',
        type: 'MEASUREMENT',
        allowedUnits: ['V', 'kV'],
        isSearchable: true,
        isTitleComponent: true,
        titleOrder: 45,
        sortOrder: 100,
      },
      {
        attributeKey: 'power_rating',
        label: 'Power rating',
        section: 'PRODUCT_DESCRIPTION',
        type: 'MEASUREMENT',
        allowedUnits: ['W', 'kW'],
        isSearchable: true,
        sortOrder: 110,
      },
      {
        attributeKey: 'plug_type',
        label: 'Plug or connector type',
        section: 'PRODUCT_DESCRIPTION',
        type: 'TEXT',
        maxLength: 64,
        isVariantDimension: true,
        sortOrder: 120,
      },
      {
        attributeKey: 'ip_rating',
        label: 'IP rating',
        helpText: 'Ingress protection, e.g. IP54.',
        section: 'PRODUCT_DESCRIPTION',
        type: 'TEXT',
        pattern: '^IP[0-9X][0-9X]$',
        maxLength: 8,
        sortOrder: 130,
      },
      {
        attributeKey: 'contains_battery',
        label: 'Contains or ships with a battery',
        helpText: 'Batteries restrict how a parcel can be shipped.',
        section: 'MEDICAL_COMPLIANCE',
        type: 'BOOLEAN',
        sortOrder: 30,
      },
    ],
  },

  // --- Fasteners and mechanical parts -------------------------------------
  {
    categorySlugs: ['industrial-fasteners'],
    attributes: [
      {
        attributeKey: 'thread_size',
        label: 'Thread size',
        helpText: 'As designated, e.g. M6 or 1/4"-20.',
        section: 'PRODUCT_DESCRIPTION',
        type: 'TEXT',
        maxLength: 32,
        isSearchable: true,
        isVariantDimension: true,
        isTitleComponent: true,
        titleOrder: 45,
        sortOrder: 100,
      },
      {
        attributeKey: 'length_mm',
        label: 'Length',
        section: 'PRODUCT_DESCRIPTION',
        type: 'MEASUREMENT',
        allowedUnits: ['mm', 'cm'],
        isSearchable: true,
        isVariantDimension: true,
        sortOrder: 110,
      },
      {
        attributeKey: 'tensile_grade',
        label: 'Grade or tensile class',
        helpText: 'e.g. 8.8, A2-70.',
        section: 'PRODUCT_DESCRIPTION',
        type: 'TEXT',
        maxLength: 32,
        isSearchable: true,
        sortOrder: 120,
      },
      {
        attributeKey: 'finish',
        label: 'Finish or coating',
        section: 'PRODUCT_DESCRIPTION',
        type: 'TEXT',
        maxLength: 64,
        isVariantDimension: true,
        sortOrder: 130,
      },
    ],
  },

  // --- Personal protective equipment --------------------------------------
  {
    categorySlugs: ['safety-equipment'],
    attributes: [
      {
        attributeKey: 'protection_standard',
        label: 'Standard it is certified to',
        helpText: 'e.g. EN 166, EN 388, ANSI Z87.1.',
        section: 'MEDICAL_COMPLIANCE',
        type: 'TEXT',
        maxLength: 120,
        isSearchable: true,
        isRegulatoryOnly: true,
        sortOrder: 30,
      },
      {
        attributeKey: 'ppe_category',
        label: 'PPE category',
        helpText: 'Under EU Regulation 2016/425.',
        section: 'MEDICAL_COMPLIANCE',
        type: 'DROPDOWN',
        allowedValues: [
          { value: 'I', label: 'Category I — minimal risk' },
          { value: 'II', label: 'Category II' },
          { value: 'III', label: 'Category III — irreversible harm or death' },
        ],
        isRegulatoryOnly: true,
        sortOrder: 40,
      },
      {
        attributeKey: 'ce_marking',
        label: 'CE marked',
        section: 'MEDICAL_COMPLIANCE',
        type: 'BOOLEAN',
        isRegulatoryOnly: true,
        sortOrder: 50,
      },
    ],
  },

  // --- Packaging and consumables ------------------------------------------
  {
    categorySlugs: ['packaging-consumables'],
    attributes: [
      {
        attributeKey: 'food_contact_safe',
        label: 'Safe for food contact',
        section: 'MEDICAL_COMPLIANCE',
        type: 'BOOLEAN',
        isSearchable: true,
        sortOrder: 30,
      },
      {
        attributeKey: 'recyclable',
        label: 'Recyclable',
        section: 'ADDITIONAL_INFORMATION',
        type: 'BOOLEAN',
        isSearchable: true,
        sortOrder: 80,
      },
      {
        attributeKey: 'thickness',
        label: 'Thickness or gauge',
        section: 'PRODUCT_DESCRIPTION',
        type: 'MEASUREMENT',
        allowedUnits: ['micron', 'mm'],
        isVariantDimension: true,
        sortOrder: 100,
      },
    ],
  },
]);

/** Insert or update one requirement, keyed as the unique index is. */
async function upsertRequirement(seed: RequirementSeed): Promise<void> {
  const existing = await prisma.sellerOnboardingRequirement.findFirst({
    where: {
      countryKey: seed.countryKey,
      stepKey: seed.stepKey,
      fieldKey: seed.fieldKey,
      appliesToKind: seed.appliesToKind ?? null,
    },
    select: { id: true },
  });

  const data = {
    countryCode: seed.countryKey === '*' ? null : seed.countryKey,
    countryKey: seed.countryKey,
    stepKey: seed.stepKey,
    fieldKey: seed.fieldKey,
    label: seed.label,
    helpText: seed.helpText ?? null,
    isRequired: seed.isRequired ?? true,
    isDocument: seed.isDocument ?? false,
    validationPattern: seed.validationPattern ?? null,
    appliesToKind: seed.appliesToKind ?? null,
    sortOrder: seed.sortOrder ?? 0,
  };

  if (existing === null) {
    await prisma.sellerOnboardingRequirement.create({ data: { id: newId(), ...data } });
    return;
  }

  await prisma.sellerOnboardingRequirement.update({ where: { id: existing.id }, data });
}

/**
 * One seed row as columns.
 *
 * Shared by both upserts below so a global definition and a category-scoped one
 * cannot drift in how a seed maps onto a row.
 */
function attributeColumns(seed: AttributeSeed, categoryId: string | null) {
  return {
    categoryId,
    // The category id, or '*'. Never null: MariaDB treats every NULL in a
    // UNIQUE index as distinct, so a nullable `categoryId` in the key would
    // let two global definitions of `gtin` both be accepted.
    categoryKey: categoryId ?? '*',
    attributeKey: seed.attributeKey,
    label: seed.label,
    helpText: seed.helpText ?? null,
    section: seed.section,
    type: seed.type,
    isRequired: seed.isRequired ?? false,
    unit: seed.unit ?? null,
    allowedUnitsJson: (seed.allowedUnits ?? null) as never,
    allowedValuesJson: (seed.allowedValues ?? null) as never,
    minNumber: seed.minNumber ?? null,
    maxNumber: seed.maxNumber ?? null,
    minLength: seed.minLength ?? null,
    maxLength: seed.maxLength ?? null,
    pattern: seed.pattern ?? null,
    isSearchable: seed.isSearchable ?? false,
    isVariantDimension: seed.isVariantDimension ?? false,
    isTitleComponent: seed.isTitleComponent ?? false,
    titleOrder: seed.titleOrder ?? null,
    isRegulatoryOnly: seed.isRegulatoryOnly ?? false,
    sortOrder: seed.sortOrder,
    isActive: true,
  };
}

/** A field every category inherits. */
async function upsertGlobalAttribute(seed: AttributeSeed): Promise<void> {
  const data = attributeColumns(seed, null);

  await prisma.categoryAttributeDefinition.upsert({
    where: { categoryKey_attributeKey: { categoryKey: '*', attributeKey: seed.attributeKey } },
    create: { id: newId(), ...data },
    update: data,
  });
}

/**
 * A field that belongs to one category and everything beneath it.
 *
 * An override of a global definition with the same key is legal and useful: a
 * category can make an optional field required, or narrow its allowed values,
 * without the global row being touched. `loadListingSchema` resolves which one
 * wins.
 */
async function upsertCategoryAttribute(categoryId: string, seed: AttributeSeed): Promise<void> {
  const data = attributeColumns(seed, categoryId);

  await prisma.categoryAttributeDefinition.upsert({
    where: {
      categoryKey_attributeKey: { categoryKey: categoryId, attributeKey: seed.attributeKey },
    },
    create: { id: newId(), ...data },
    update: data,
  });
}

/**
 * Seed the Seller Hub's configuration.
 *
 * Returns counts so the seed's summary can report what it wrote, in the style
 * the rest of `seed/index.ts` uses.
 */
export async function seedSellerHub(): Promise<{
  requirements: number;
  attributes: number;
  categoryAttributes: number;
  retiredGlobals: number;
  flags: number;
}> {
  for (const requirement of REQUIREMENTS) {
    await upsertRequirement(requirement);
  }

  for (const attribute of GLOBAL_ATTRIBUTES) {
    await upsertGlobalAttribute(attribute);
  }

  /*
   * Retire global definitions this seed no longer ships.
   *
   * The first version of this file defined the medical fields globally, which
   * made every category in the marketplace ask a seller of cable ties for a
   * device class. Moving them to the categories they belong to is only half the
   * fix - the rows written by the earlier seed are still there, and a
   * definition nobody ships is still a question every seller is asked.
   *
   * Deactivated rather than deleted: a listing may already hold a value against
   * one, and deleting the definition would leave that value unexplained.
   * `loadListingSchema` reads only `isActive`, so this is enough to stop it
   * being asked while keeping what was answered.
   *
   * Scoped to GLOBAL rows on purpose. A category-scoped definition an operator
   * added themselves is theirs, and a re-seed must not switch it off.
   */
  const shippedGlobalKeys = GLOBAL_ATTRIBUTES.map((attribute) => attribute.attributeKey);

  const retired = await prisma.categoryAttributeDefinition.updateMany({
    where: { categoryKey: '*', attributeKey: { notIn: shippedGlobalKeys }, isActive: true },
    data: { isActive: false },
  });

  /*
   * The category-specific sets.
   *
   * Matched by slug and SILENTLY SKIPPED where the category does not exist.
   * That is the behaviour a product sold to many operators needs: a deployment
   * selling only packaging never gets the medical fields, and one that later
   * adds a Medical Devices category gets them on the next seed without anybody
   * editing code.
   */
  let categoryAttributes = 0;

  for (const set of CATEGORY_ATTRIBUTE_SETS) {
    const categories = await prisma.category.findMany({
      where: { slug: { in: [...set.categorySlugs] } },
      select: { id: true },
    });

    for (const category of categories) {
      for (const attribute of set.attributes) {
        await upsertCategoryAttribute(category.id, attribute);
        categoryAttributes += 1;
      }
    }
  }

  /**
   * Marketplace policy switches.
   *
   * `seller.allowSellerEditedTitles` defaults to OFF, which is the policy the
   * reference screens describe and the one that keeps a catalogue comparable:
   * where it is off, a seller who thinks the generated title is wrong asks for
   * a correction rather than typing "BEST QUALITY" into it.
   */
  const flags = [
    {
      key: 'seller.allowSellerEditedTitles',
      description:
        'Let sellers edit the automatically generated product title. Off keeps titles ' +
        'comparable across sellers; sellers can request a correction instead.',
      enabled: false,
    },
    {
      key: 'seller.hubEnabled',
      description:
        'Show "Become a seller" and the Seller Hub. Turn off to run this deployment as a ' +
        'single-supplier store with no marketplace.',
      enabled: true,
    },
  ];

  for (const flag of flags) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      create: { id: newId(), ...flag },
      // Only the description is refreshed. The switch itself is the operator's
      // decision and a re-seed must not quietly turn their marketplace back on.
      update: { description: flag.description },
    });
  }

  return {
    requirements: REQUIREMENTS.length,
    attributes: GLOBAL_ATTRIBUTES.length,
    categoryAttributes,
    retiredGlobals: retired.count,
    flags: flags.length,
  };
}
