/**
 * The departments a marketplace starts life with.
 *
 * A seller can list anything. The category picker in the listing wizard is
 * what decides whether that is true in practice: it offers the categories this
 * deployment actually has, so a deployment whose only department arrived on a
 * supplier's spreadsheet offers exactly that department, and a seller with a
 * box of cable ties to sell finds nowhere to put them. That is not a
 * marketplace with one department in it — it is a marketplace nobody else can
 * sell on.
 *
 * So a fresh deployment is planted with a broad, plainly named set of
 * departments covering the trades a general marketplace serves, each with a
 * handful of sub-categories underneath. From the moment the seed has run, a
 * seller can find somewhere sensible for whatever they sell.
 *
 * Three things this is careful about, because the catalogue belongs to the
 * operator and this is a product other companies run:
 *
 *   - **A department that already exists is left entirely alone**, children and
 *     all. A deployment that already has "Medical Devices" with twenty-six
 *     sub-categories of its own keeps them; this does not add its own eight
 *     alongside. Matching is by slug.
 *   - **Nothing is ever renamed, reactivated or deleted.** An operator who
 *     switched a department off, renamed it, or reordered it has made a
 *     decision, and re-running the seed must not put our guess back.
 *   - **Names are a starting point, not a rule.** Everything here can be
 *     renamed, re-parented, archived or deleted in the admin panel, and a
 *     category the operator added themselves is never touched.
 *
 * Empty departments do not clutter the shop front: the storefront home and
 * category pages show only categories with something published beneath them
 * (`stockedCategories` in the customer app), so a department nobody has listed
 * in yet is visible to a seller choosing where to file a product and to nobody
 * else.
 *
 * `seedSellerHub` runs after this and attaches its category-specific listing
 * fields by slug, which is why the medical department below carries the slug
 * that seed looks for.
 */
import { newId } from '../infra/ids.js';
import { prisma } from '../infra/prisma.js';

interface ChildSeed {
  name: string;
  slug: string;
}

interface DepartmentSeed {
  name: string;
  slug: string;
  sortOrder: number;
  children: readonly ChildSeed[];
}

/**
 * The starter set.
 *
 * Deliberately wide and shallow — two levels. A seller picks the department
 * they think in and then one step more, and the detailed shelf a trade wants
 * ("Closed IV Cannula", "M6 hex bolt") is the operator's to add underneath,
 * because only they know what they trade in. Three levels of guesses from us
 * would be a filing cabinet nobody agrees with.
 *
 * `sortOrder` is in tens so an operator can slot a department of their own
 * between two of these without renumbering the rest.
 */
const DEPARTMENTS: readonly DepartmentSeed[] = Object.freeze([
  {
    name: 'Medical Devices',
    slug: 'medical-devices',
    sortOrder: 10,
    children: [
      { name: 'Diagnostics & Monitoring', slug: 'diagnostics-monitoring' },
      { name: 'Surgical Instruments', slug: 'surgical-instruments' },
      { name: 'Infusion & Injection', slug: 'infusion-injection' },
      { name: 'Patient Care & Mobility', slug: 'patient-care-mobility' },
      { name: 'Imaging & Radiology', slug: 'imaging-radiology' },
      { name: 'Rehabilitation & Physiotherapy', slug: 'rehabilitation-physiotherapy' },
      { name: 'Dental Supplies', slug: 'dental-supplies' },
      { name: 'Medical Furniture', slug: 'medical-furniture' },
    ],
  },
  {
    name: 'Laboratory & Scientific',
    slug: 'laboratory-scientific',
    sortOrder: 20,
    children: [
      { name: 'Lab Instruments', slug: 'lab-instruments' },
      { name: 'Glassware & Plasticware', slug: 'lab-glassware-plasticware' },
      { name: 'Reagents & Chemicals', slug: 'lab-reagents-chemicals' },
      { name: 'Consumables & Sampling', slug: 'lab-consumables-sampling' },
      { name: 'Measurement & Calibration', slug: 'measurement-calibration' },
    ],
  },
  {
    name: 'Industrial Supplies',
    slug: 'industrial-supplies',
    sortOrder: 30,
    children: [
      { name: 'Fasteners & Fixings', slug: 'fasteners-fixings' },
      { name: 'Bearings & Power Transmission', slug: 'bearings-power-transmission' },
      { name: 'Hydraulics & Pneumatics', slug: 'hydraulics-pneumatics' },
      { name: 'Pumps & Valves', slug: 'pumps-valves' },
      { name: 'Abrasives', slug: 'abrasives' },
      { name: 'Lubricants & Adhesives', slug: 'lubricants-adhesives' },
      { name: 'Welding & Soldering', slug: 'welding-soldering' },
      { name: 'Material Handling', slug: 'material-handling' },
    ],
  },
  {
    name: 'Tools & Hardware',
    slug: 'tools-hardware',
    sortOrder: 40,
    children: [
      { name: 'Hand Tools', slug: 'hand-tools' },
      { name: 'Power Tools', slug: 'power-tools' },
      { name: 'Cutting Tools', slug: 'cutting-tools' },
      { name: 'Measuring & Layout', slug: 'measuring-layout' },
      { name: 'Tool Storage', slug: 'tool-storage' },
    ],
  },
  {
    name: 'Electrical & Lighting',
    slug: 'electrical-lighting',
    sortOrder: 50,
    children: [
      { name: 'Cables & Wiring', slug: 'cables-wiring' },
      { name: 'Switches & Sockets', slug: 'switches-sockets' },
      { name: 'Circuit Protection', slug: 'circuit-protection' },
      { name: 'Motors & Drives', slug: 'motors-drives' },
      { name: 'Lighting', slug: 'lighting' },
      { name: 'Batteries & Power Supplies', slug: 'batteries-power-supplies' },
    ],
  },
  {
    name: 'Electronics & Components',
    slug: 'electronics-components',
    sortOrder: 60,
    children: [
      { name: 'Electronic Components', slug: 'electronic-components' },
      { name: 'Sensors & Automation', slug: 'sensors-automation' },
      { name: 'Test & Measurement', slug: 'test-measurement' },
      { name: 'Enclosures & Connectors', slug: 'enclosures-connectors' },
    ],
  },
  {
    name: 'Computers & IT',
    slug: 'computers-it',
    sortOrder: 70,
    children: [
      { name: 'Laptops & Desktops', slug: 'laptops-desktops' },
      { name: 'Peripherals & Accessories', slug: 'computer-peripherals' },
      { name: 'Networking', slug: 'networking' },
      { name: 'Storage & Media', slug: 'storage-media' },
      { name: 'Printers & Scanners', slug: 'printers-scanners' },
      { name: 'Software & Licences', slug: 'software-licences' },
    ],
  },
  {
    name: 'Phones & Communication',
    slug: 'phones-communication',
    sortOrder: 80,
    children: [
      { name: 'Mobile Phones', slug: 'mobile-phones' },
      { name: 'Phone Accessories', slug: 'phone-accessories' },
      { name: 'Two-Way Radios', slug: 'two-way-radios' },
      { name: 'Telephony', slug: 'telephony' },
    ],
  },
  {
    name: 'Office & Stationery',
    slug: 'office-stationery',
    sortOrder: 90,
    children: [
      { name: 'Paper & Notebooks', slug: 'paper-notebooks' },
      { name: 'Writing & Correction', slug: 'writing-correction' },
      { name: 'Filing & Organisation', slug: 'filing-organisation' },
      { name: 'Office Machines', slug: 'office-machines' },
      { name: 'Printer Supplies', slug: 'printer-supplies' },
    ],
  },
  {
    name: 'Packaging & Shipping',
    slug: 'packaging-shipping',
    sortOrder: 100,
    children: [
      { name: 'Boxes & Cartons', slug: 'boxes-cartons' },
      { name: 'Tapes & Strapping', slug: 'tapes-strapping' },
      { name: 'Protective Packaging', slug: 'protective-packaging' },
      { name: 'Bags & Films', slug: 'bags-films' },
      { name: 'Labels & Marking', slug: 'labels-marking' },
    ],
  },
  {
    name: 'Safety & Protective Equipment',
    slug: 'safety-protective-equipment',
    sortOrder: 110,
    children: [
      { name: 'Hand Protection', slug: 'hand-protection' },
      { name: 'Eye & Face Protection', slug: 'eye-face-protection' },
      { name: 'Respiratory Protection', slug: 'respiratory-protection' },
      { name: 'Head & Fall Protection', slug: 'head-fall-protection' },
      { name: 'Protective Clothing', slug: 'protective-clothing' },
      { name: 'Safety Footwear', slug: 'safety-footwear' },
      { name: 'Fire Safety & First Aid', slug: 'fire-safety-first-aid' },
    ],
  },
  {
    name: 'Cleaning & Hygiene',
    slug: 'cleaning-hygiene',
    sortOrder: 120,
    children: [
      { name: 'Cleaning Chemicals', slug: 'cleaning-chemicals' },
      { name: 'Disinfection & Sterilisation', slug: 'disinfection-sterilisation' },
      { name: 'Cleaning Equipment', slug: 'cleaning-equipment' },
      { name: 'Washroom Supplies', slug: 'washroom-supplies' },
      { name: 'Waste Management', slug: 'waste-management' },
    ],
  },
  {
    name: 'Building & Construction',
    slug: 'building-construction',
    sortOrder: 130,
    children: [
      { name: 'Building Materials', slug: 'building-materials' },
      { name: 'Plumbing & Sanitary', slug: 'plumbing-sanitary' },
      { name: 'Heating, Ventilation & Cooling', slug: 'heating-ventilation-cooling' },
      { name: 'Paint & Surface Finishing', slug: 'paint-surface-finishing' },
      { name: 'Doors, Windows & Ironmongery', slug: 'doors-windows-ironmongery' },
    ],
  },
  {
    name: 'Automotive & Transport',
    slug: 'automotive-transport',
    sortOrder: 140,
    children: [
      { name: 'Vehicle Parts', slug: 'vehicle-parts' },
      { name: 'Tyres & Wheels', slug: 'tyres-wheels' },
      { name: 'Garage Equipment', slug: 'garage-equipment' },
      { name: 'Vehicle Care', slug: 'vehicle-care' },
    ],
  },
  {
    name: 'Agriculture & Gardening',
    slug: 'agriculture-gardening',
    sortOrder: 150,
    children: [
      { name: 'Farm Equipment', slug: 'farm-equipment' },
      { name: 'Irrigation', slug: 'irrigation' },
      { name: 'Seeds, Feed & Fertiliser', slug: 'seeds-feed-fertiliser' },
      { name: 'Garden Tools & Outdoor', slug: 'garden-tools-outdoor' },
    ],
  },
  {
    name: 'Food Service & Catering',
    slug: 'food-service-catering',
    sortOrder: 160,
    children: [
      { name: 'Commercial Kitchen Equipment', slug: 'commercial-kitchen-equipment' },
      { name: 'Tableware & Serving', slug: 'tableware-serving' },
      { name: 'Disposables & Takeaway', slug: 'disposables-takeaway' },
      { name: 'Food Storage & Refrigeration', slug: 'food-storage-refrigeration' },
    ],
  },
  {
    name: 'Furniture & Fixtures',
    slug: 'furniture-fixtures',
    sortOrder: 170,
    children: [
      { name: 'Office Furniture', slug: 'office-furniture' },
      { name: 'Seating', slug: 'seating' },
      { name: 'Storage & Shelving', slug: 'storage-shelving' },
      { name: 'Retail Display', slug: 'retail-display' },
    ],
  },
  {
    name: 'Home & Kitchen',
    slug: 'home-kitchen',
    sortOrder: 180,
    children: [
      { name: 'Kitchenware', slug: 'kitchenware' },
      { name: 'Home Appliances', slug: 'home-appliances' },
      { name: 'Bedding & Bath', slug: 'bedding-bath' },
      { name: 'Home Decor', slug: 'home-decor' },
    ],
  },
  {
    name: 'Clothing & Textiles',
    slug: 'clothing-textiles',
    sortOrder: 190,
    children: [
      { name: 'Workwear & Uniforms', slug: 'workwear-uniforms' },
      { name: 'Everyday Clothing', slug: 'everyday-clothing' },
      { name: 'Footwear', slug: 'footwear' },
      { name: 'Fabrics & Trims', slug: 'fabrics-trims' },
    ],
  },
  {
    name: 'Beauty & Personal Care',
    slug: 'beauty-personal-care',
    sortOrder: 200,
    children: [
      { name: 'Skin & Hair Care', slug: 'skin-hair-care' },
      { name: 'Cosmetics', slug: 'cosmetics' },
      { name: 'Personal Hygiene', slug: 'personal-hygiene' },
      { name: 'Salon & Spa Supplies', slug: 'salon-spa-supplies' },
    ],
  },
  {
    name: 'Sports & Outdoors',
    slug: 'sports-outdoors',
    sortOrder: 210,
    children: [
      { name: 'Fitness Equipment', slug: 'fitness-equipment' },
      { name: 'Team Sports', slug: 'team-sports' },
      { name: 'Camping & Outdoor', slug: 'camping-outdoor' },
      { name: 'Cycling', slug: 'cycling' },
    ],
  },
  {
    name: 'Toys, Hobbies & Crafts',
    slug: 'toys-hobbies-crafts',
    sortOrder: 220,
    children: [
      { name: 'Toys & Games', slug: 'toys-games' },
      { name: 'Craft Materials', slug: 'craft-materials' },
      { name: 'Musical Instruments', slug: 'musical-instruments' },
      { name: 'Gifts & Party', slug: 'gifts-party' },
    ],
  },
  {
    name: 'Books & Media',
    slug: 'books-media',
    sortOrder: 230,
    children: [
      { name: 'Books', slug: 'books' },
      { name: 'Educational Materials', slug: 'educational-materials' },
      { name: 'Audio & Video', slug: 'audio-video' },
    ],
  },
  {
    name: 'Chemicals & Raw Materials',
    slug: 'chemicals-raw-materials',
    sortOrder: 240,
    children: [
      { name: 'Industrial Chemicals', slug: 'industrial-chemicals' },
      { name: 'Plastics & Polymers', slug: 'plastics-polymers' },
      { name: 'Metals & Alloys', slug: 'metals-alloys' },
      { name: 'Rubber & Sealing', slug: 'rubber-sealing' },
    ],
  },
  {
    name: 'Energy & Environment',
    slug: 'energy-environment',
    sortOrder: 250,
    children: [
      { name: 'Solar & Renewables', slug: 'solar-renewables' },
      { name: 'Generators & Backup Power', slug: 'generators-backup-power' },
      { name: 'Water Treatment', slug: 'water-treatment' },
      { name: 'Air Quality', slug: 'air-quality' },
    ],
  },
]);

export interface StarterCategoryResult {
  /** Departments created by this run. */
  departments: number;
  /** Sub-categories created by this run. */
  children: number;
  /** Departments already present, and therefore left untouched. */
  skipped: number;
}

/**
 * Plant the starter departments.
 *
 * Idempotent, and create-only: a slug that already exists is never written to,
 * so a second run reports everything skipped and changes nothing.
 */
export async function seedStarterCategories(): Promise<StarterCategoryResult> {
  // One read rather than a query per slug. The taxonomy is a hundred-odd rows
  // and this runs against a live database on every deployment upgrade.
  const taken = new Set(
    (
      await prisma.category.findMany({
        where: {
          slug: {
            in: [
              ...DEPARTMENTS.map((department) => department.slug),
              ...DEPARTMENTS.flatMap((department) =>
                department.children.map((child) => child.slug),
              ),
            ],
          },
        },
        select: { slug: true },
      })
    ).map((row) => row.slug),
  );

  let departments = 0;
  let children = 0;
  let skipped = 0;

  for (const department of DEPARTMENTS) {
    if (taken.has(department.slug)) {
      // The operator already has this department. What is filed under it is
      // theirs, so nothing of ours is added beside it.
      skipped += 1;
      continue;
    }

    const departmentId = newId();

    await prisma.category.create({
      data: {
        id: departmentId,
        name: department.name,
        slug: department.slug,
        parentId: null,
        path: '/',
        depth: 0,
        sortOrder: department.sortOrder,
        // Active on creation, unlike a category added by hand in the panel. A
        // department nobody can see is a department nobody can list in, and the
        // point of planting these is that a seller has somewhere to file a
        // product on the day the deployment opens.
        isActive: true,
      },
    });

    departments += 1;

    for (const [index, child] of department.children.entries()) {
      // A sub-category slug this deployment already uses somewhere else keeps
      // its existing home: slugs are unique across the whole tree, and taking
      // one would move somebody's category by accident.
      if (taken.has(child.slug)) continue;

      await prisma.category.create({
        data: {
          id: newId(),
          name: child.name,
          slug: child.slug,
          parentId: departmentId,
          path: `/${departmentId}/`,
          depth: 1,
          sortOrder: (index + 1) * 10,
          isActive: true,
        },
      });

      taken.add(child.slug);
      children += 1;
    }
  }

  return { departments, children, skipped };
}
