/**
 * The starter taxonomy, as data.
 *
 * Held apart from the seed that writes it so that anything needing to KNOW the
 * shelves - the variant template registry, and the test that keeps the two in
 * step - can read them without importing a database client. The seed imports
 * this; there is still exactly one list.
 */
export interface ChildSeed {
  name: string;
  slug: string;
}

export interface DepartmentSeed {
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
export const STARTER_DEPARTMENTS: readonly DepartmentSeed[] = Object.freeze([
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
