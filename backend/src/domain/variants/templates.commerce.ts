/**
 * Variant templates: the six departments a business buys FOR ITSELF.
 *
 * Computers & IT, Phones & Communication, Office & Stationery,
 * Packaging & Shipping, Safety & Protective Equipment, Cleaning & Hygiene.
 *
 * Two rules this group exists to hold.
 *
 * A LICENCE KEY IS NOT A VARIANT VALUE. Software varies by edition, seat count
 * and term - all three are things a buyer chooses before paying. The key
 * itself is created afterwards, belongs to one order, and putting it anywhere
 * near a catalogue row would publish it.
 *
 * A SAFETY RATING IS NOT A CHOICE THE SYSTEM MAKES. A glove's cut level and a
 * mask's filtration class are axes because a seller genuinely stocks several,
 * and the value shown is whatever the seller stored. Nothing here invents one,
 * and a product with no rating recorded shows no rating - not "standard".
 */
import { template, type VariantTemplate } from './axis.js';
import {
  apparelSize,
  capacity,
  choice,
  closure,
  colour,
  flag,
  grade,
  length,
  material,
  measure,
  netVolume,
  numericSize,
  packCount,
  pattern,
  sizeSystem,
  voltage,
} from './library.js';

// ---------------------------------------------------------------------------
// 6. COMPUTERS & IT
// ---------------------------------------------------------------------------

const COMPUTERS: readonly VariantTemplate[] = [
  template('computers-it', 'laptops-desktops', 'Laptops & Desktops', [
    choice('form_factor', 'Form factor', ['Laptop', 'Desktop tower', 'All-in-one', 'Mini PC', 'Workstation'], {
      importance: 'RECOMMENDED',
    }),
    choice('processor', 'Processor', ['Intel Core i3', 'Intel Core i5', 'Intel Core i7', 'AMD Ryzen 5', 'AMD Ryzen 7']),
    choice('ram', 'RAM', ['4 GB', '8 GB', '16 GB', '32 GB', '64 GB'], { importance: 'RECOMMENDED' }),
    choice('storage', 'Storage', ['256 GB SSD', '512 GB SSD', '1 TB SSD', '2 TB SSD', '1 TB HDD'], {
      importance: 'RECOMMENDED',
    }),
    choice('graphics', 'Graphics', ['Integrated', 'NVIDIA RTX 4050', 'NVIDIA RTX 4060', 'AMD Radeon']),
    measure('display_size', 'Display size', ['in'], { suggestions: ['13.3', '14', '15.6', '16', '17.3'] }),
    choice('operating_system', 'Operating system', ['Windows 11 Home', 'Windows 11 Pro', 'Linux', 'No OS'], {
      importance: 'RECOMMENDED',
    }),
    colour(['Silver', 'Black', 'Grey', 'Blue']),
    choice('keyboard_layout', 'Keyboard layout', ['UK', 'US', 'EU (ISO)', 'IN']),
    choice('screen_resolution', 'Screen resolution', ['HD', 'Full HD', 'QHD', '4K UHD']),
    choice('screen_type', 'Screen type', ['Matte', 'Glossy', 'Touchscreen', 'OLED']),
    choice('warranty', 'Warranty', ['1 year', '2 years', '3 years'], { inTitle: false }),
  ]),

  template('computers-it', 'computer-peripherals', 'Peripherals & Accessories', [
    choice('product_type', 'Product type', ['Keyboard', 'Mouse', 'Monitor', 'Webcam', 'Headset', 'Docking station'], {
      importance: 'RECOMMENDED',
    }),
    choice('connectivity', 'Connectivity', ['USB-A', 'USB-C', 'Bluetooth', '2.4 GHz wireless', 'HDMI', 'DisplayPort'], {
      importance: 'RECOMMENDED',
    }),
    choice('layout', 'Layout', ['Full size', 'Tenkeyless', 'Compact', 'UK', 'US']),
    measure('size', 'Size', ['in', 'mm'], { suggestions: ['21.5', '24', '27', '32'] }),
    colour(['Black', 'White', 'Silver', 'Grey']),
    choice('compatibility', 'Compatibility', ['Windows', 'macOS', 'Linux', 'Universal']),
    choice('bundle', 'Bundle', ['Single unit', 'Keyboard and mouse combo', 'With stand']),
    choice('switch_type', 'Switch or sensor', ['Membrane', 'Mechanical', 'Optical', 'Laser']),
    flag('backlit', 'Backlight', ['Backlit', 'Not backlit']),
  ]),

  template('computers-it', 'networking', 'Networking', [
    choice('device_type', 'Device type', ['Switch', 'Router', 'Access point', 'Firewall', 'Media converter', 'NIC'], {
      importance: 'RECOMMENDED',
    }),
    choice('port_count', 'Ports', ['5', '8', '16', '24', '48'], { importance: 'RECOMMENDED' }),
    choice('port_speed', 'Port speed', ['100 Mbps', '1 Gbps', '2.5 Gbps', '10 Gbps'], { importance: 'RECOMMENDED' }),
    choice('wifi_standard', 'Wi-Fi standard', ['Wi-Fi 5 (ac)', 'Wi-Fi 6 (ax)', 'Wi-Fi 6E', 'Wi-Fi 7']),
    choice('bands', 'Bands', ['2.4 GHz', 'Dual band', 'Tri band']),
    flag('poe', 'Power over Ethernet', ['PoE', 'Non-PoE']),
    choice('management', 'Management', ['Unmanaged', 'Smart managed', 'Fully managed']),
    choice('power', 'Power', ['External adapter', 'Internal PSU', 'PoE powered']),
    choice('mounting', 'Mounting', ['Desktop', 'Rack mount', 'Wall mount', 'DIN rail']),
    choice('antenna', 'Antennas', ['Internal', '2 external', '4 external', '6 external']),
  ]),

  template('computers-it', 'storage-media', 'Storage & Media', [
    choice('media_type', 'Type', ['SSD', 'HDD', 'NVMe SSD', 'USB flash drive', 'Memory card', 'Optical disc'], {
      importance: 'RECOMMENDED',
    }),
    choice('storage', 'Capacity', ['128 GB', '256 GB', '512 GB', '1 TB', '2 TB', '4 TB', '8 TB'], {
      importance: 'RECOMMENDED',
    }),
    choice('interface', 'Interface', ['SATA III', 'PCIe 3.0', 'PCIe 4.0', 'USB 3.2', 'Thunderbolt']),
    choice('form_factor', 'Form factor', ['2.5 in', '3.5 in', 'M.2 2280', 'mSATA', 'microSD']),
    choice('speed_class', 'Read / write class', ['Class 10', 'U3', 'V30', 'V60', 'V90']),
    measure('endurance', 'Endurance', ['TBW', 'DWPD']),
    packCount(['1', '2', '5', '10', '25', '50']),
    choice('use_case', 'Intended use', ['Consumer', 'NAS', 'Surveillance', 'Enterprise']),
    measure('cache', 'Cache', ['MB'], { suggestions: ['64', '128', '256', '512'] }),
  ]),

  template('computers-it', 'printers-scanners', 'Printers & Scanners', [
    choice('technology', 'Technology', ['Inkjet', 'Laser', 'Thermal', 'Dot matrix', 'Flatbed scanner'], {
      importance: 'RECOMMENDED',
    }),
    choice('colour_mode', 'Mono or colour', ['Monochrome', 'Colour'], {
      importance: 'RECOMMENDED',
      allowsCustomValues: false,
    }),
    measure('print_speed', 'Print speed', ['ppm'], { suggestions: ['20', '25', '30', '40'] }),
    choice('paper_size', 'Maximum paper size', ['A4', 'A3', 'Legal', 'A0']),
    flag('duplex', 'Duplex', ['Duplex', 'Single sided']),
    choice('connectivity', 'Connectivity', ['USB', 'Ethernet', 'Wi-Fi', 'Wi-Fi Direct']),
    measure('duty_cycle', 'Duty cycle', ['pages/month']),
    choice('feeder', 'Feeder', ['Manual feed', 'ADF', 'Extra paper tray']),
    choice('functions', 'Functions', ['Print only', 'Print and scan', 'All-in-one', 'All-in-one with fax']),
    choice('ink_system', 'Ink system', ['Cartridge', 'Ink tank', 'Toner']),
  ]),

  template('computers-it', 'software-licences', 'Software & Licences', [
    choice('edition', 'Edition', ['Standard', 'Professional', 'Business', 'Enterprise'], {
      importance: 'RECOMMENDED',
    }),
    choice('seat_count', 'Users or devices', ['1', '3', '5', '10', '25', '50', '100'], {
      importance: 'RECOMMENDED',
    }),
    choice('term', 'Subscription term', ['1 month', '1 year', '2 years', '3 years', 'Perpetual'], {
      importance: 'RECOMMENDED',
    }),
    choice('platform', 'Platform', ['Windows', 'macOS', 'Linux', 'Cross-platform', 'Cloud']),
    choice('delivery', 'Delivery', ['Electronic delivery', 'Boxed media'], { allowsCustomValues: false }),
    choice('licence_type', 'Licence type', ['Commercial', 'Education', 'Non-profit', 'Government']),
    choice('renewal', 'Renewal', ['New licence', 'Renewal', 'Upgrade']),
    choice('support_level', 'Support', ['Standard', 'Business hours', '24x7']),
  ]),
];

// ---------------------------------------------------------------------------
// 7. PHONES & COMMUNICATION
// ---------------------------------------------------------------------------

const PHONES: readonly VariantTemplate[] = [
  template('phones-communication', 'mobile-phones', 'Mobile Phones', [
    choice('model', 'Model', [], { importance: 'RECOMMENDED' }),
    choice('ram', 'RAM', ['4 GB', '6 GB', '8 GB', '12 GB', '16 GB'], { importance: 'RECOMMENDED' }),
    choice('storage', 'Storage', ['64 GB', '128 GB', '256 GB', '512 GB', '1 TB'], { importance: 'RECOMMENDED' }),
    colour(['Black', 'White', 'Blue', 'Green', 'Titanium'], 'RECOMMENDED'),
    choice('sim_configuration', 'SIM', ['Single SIM', 'Dual SIM', 'eSIM', 'Dual SIM + eSIM']),
    choice('network', 'Network', ['4G', '5G'], { allowsCustomValues: false }),
    choice('region', 'Regional variant', ['India', 'EU', 'UK', 'Global']),
    choice('warranty', 'Warranty', ['Standard warranty', 'Extended warranty']),
    choice('screen_size', 'Screen size', ['6.1 in', '6.4 in', '6.7 in', '6.8 in']),
    choice('battery_capacity', 'Battery', ['4000 mAh', '5000 mAh', '6000 mAh']),
    choice('condition_grade', 'Condition', ['New', 'Refurbished'], { allowsCustomValues: false }),
  ]),

  template('phones-communication', 'phone-accessories', 'Phone Accessories', [
    choice('accessory_type', 'Type', ['Case', 'Screen protector', 'Charger', 'Cable', 'Power bank', 'Mount'], {
      importance: 'RECOMMENDED',
    }),
    choice('compatibility', 'Compatible with', [], { importance: 'RECOMMENDED' }),
    choice('connector', 'Connector', ['USB-C', 'Lightning', 'Micro USB', 'Wireless (Qi)']),
    length(['m', 'cm'], ['0.5', '1', '1.5', '2', '3']),
    colour(['Black', 'White', 'Clear', 'Blue', 'Red']),
    material(['Silicone', 'TPU', 'Polycarbonate', 'Leather', 'Tempered glass']),
    packCount(['1', '2', '5', '10']),
    choice('output_power', 'Output', ['10 W', '18 W', '25 W', '33 W', '65 W']),
    pattern(['Plain', 'Printed', 'Transparent', 'Matte', 'Carbon fibre']),
  ]),

  template('phones-communication', 'two-way-radios', 'Two-Way Radios', [
    choice('frequency_band', 'Frequency band', ['UHF', 'VHF', 'Dual band', 'PMR446'], {
      importance: 'RECOMMENDED',
    }),
    choice('channel_count', 'Channels', ['8', '16', '32', '128', '256']),
    measure('transmit_power', 'Transmit power', ['W'], { suggestions: ['0.5', '2', '4', '5', '10'] }),
    measure('battery_capacity', 'Battery capacity', ['mAh'], { suggestions: ['1500', '2000', '2600', '3800'] }),
    choice('ip_rating', 'Ingress protection', ['IP54', 'IP66', 'IP67', 'IP68']),
    packCount(['1', '2', '4', '6', '10'], 'Supplied as'),
    choice('licence_class', 'Licence class', ['Licence free', 'Licensed']),
    choice('kit_contents', 'Kit contents', ['Radio only', 'With charger', 'With headset']),
  ]),

  template('phones-communication', 'telephony', 'Telephony', [
    choice('system_type', 'Type', ['Corded phone', 'Cordless phone', 'IP phone', 'PBX', 'Conference phone'], {
      importance: 'RECOMMENDED',
    }),
    choice('line_count', 'Lines supported', ['1', '2', '4', '8', '16']),
    choice('protocol', 'Connectivity', ['Analogue', 'SIP', 'DECT', 'Bluetooth', 'PoE']),
    choice('handset_count', 'Handsets', ['1', '2', '3', '4', '6'], { importance: 'RECOMMENDED' }),
    choice('power', 'Power', ['Mains adapter', 'PoE', 'Line powered']),
    choice('region', 'Regional compatibility', ['UK', 'EU', 'India', 'US']),
    flag('answering_machine', 'Answering machine', ['With answering machine', 'Without']),
    colour(['Black', 'White', 'Grey']),
  ]),
];

// ---------------------------------------------------------------------------
// 8. OFFICE & STATIONERY
// ---------------------------------------------------------------------------

const OFFICE: readonly VariantTemplate[] = [
  template('office-stationery', 'paper-notebooks', 'Paper & Notebooks', [
    choice('paper_size', 'Paper size', ['A4', 'A5', 'A3', 'Letter', 'Legal', 'B5'], { importance: 'RECOMMENDED' }),
    measure('gsm', 'GSM', ['gsm'], { importance: 'RECOMMENDED', suggestions: ['70', '75', '80', '100', '120', '160', '300'] }),
    choice('ruling', 'Ruling', ['Ruled', 'Plain', 'Squared', 'Dotted', 'Margin ruled']),
    choice('page_count', 'Pages or sheets', ['80', '100', '160', '192', '500'], { importance: 'RECOMMENDED' }),
    colour(['White', 'Cream', 'Assorted', 'Pastel']),
    choice('binding', 'Binding', ['Spiral', 'Perfect bound', 'Stapled', 'Case bound', 'Loose']),
    packCount(['1', '5', '10', '20', '50']),
    choice('brightness', 'Brightness', ['92 ISO', '94 ISO', '96 ISO', '100 ISO']),
    flag('recycled', 'Recycled content', ['Recycled', 'Virgin pulp']),
  ]),

  template('office-stationery', 'writing-correction', 'Writing & Correction', [
    choice('instrument_type', 'Type', ['Ball pen', 'Gel pen', 'Roller ball', 'Fountain pen', 'Pencil', 'Marker', 'Highlighter'], {
      importance: 'RECOMMENDED',
    }),
    colour(['Blue', 'Black', 'Red', 'Green', 'Assorted'], 'RECOMMENDED'),
    measure('tip_size', 'Tip or point size', ['mm'], { suggestions: ['0.5', '0.7', '1.0', '1.2'] }),
    choice('body_style', 'Body style', ['Retractable', 'Capped', 'Twist', 'Stick']),
    choice('refill', 'Refill', ['Refillable', 'Disposable', 'Refill only']),
    packCount(['1', '5', '10', '12', '20', '50']),
    choice('ink_type', 'Ink type', ['Ball point', 'Gel', 'Liquid ink', 'Pigment ink']),
    flag('retractable', 'Mechanism', ['Retractable', 'Capped']),
  ]),

  template('office-stationery', 'filing-organisation', 'Filing & Organisation', [
    choice('product_type', 'Type', ['Lever arch file', 'Ring binder', 'Box file', 'Document wallet', 'Suspension file', 'Magazine rack'], {
      importance: 'RECOMMENDED',
    }),
    choice('paper_size', 'Paper size', ['A4', 'A5', 'Foolscap', 'A3'], { importance: 'RECOMMENDED' }),
    measure('spine_width', 'Capacity or spine width', ['mm', 'sheets'], { suggestions: ['25', '40', '50', '75', '80'] }),
    material(['Board', 'Polypropylene', 'PVC', 'Kraft']),
    colour(['Black', 'Blue', 'Red', 'Green', 'Assorted']),
    packCount(['1', '5', '10', '25', '50']),
    choice('mechanism', 'Mechanism', ['2 ring', '4 ring', 'Lever arch', 'Box clip', 'Spring clip']),
    flag('index_included', 'Index', ['With index', 'Without index']),
  ]),

  template('office-stationery', 'office-machines', 'Office Machines', [
    choice('machine_type', 'Type', ['Shredder', 'Laminator', 'Binding machine', 'Guillotine', 'Calculator', 'Label printer'], {
      importance: 'RECOMMENDED',
    }),
    choice('performance', 'Capacity or performance', ['Personal', 'Small office', 'Departmental', 'Heavy duty'], {
      importance: 'RECOMMENDED',
    }),
    choice('paper_size', 'Paper size', ['A4', 'A3', 'A5']),
    voltage(),
    choice('connectivity', 'Connectivity', ['None', 'USB', 'Wi-Fi', 'Bluetooth']),
    colour(['Black', 'White', 'Grey', 'Silver']),
    choice('security_level', 'Security level', ['P-2', 'P-3', 'P-4', 'P-5']),
    choice('feed_capacity', 'Feed capacity', ['5 sheets', '10 sheets', '18 sheets', '24 sheets']),
  ]),

  template('office-stationery', 'printer-supplies', 'Printer Supplies', [
    choice('consumable_type', 'Type', ['Ink cartridge', 'Toner cartridge', 'Drum unit', 'Ribbon', 'Thermal roll'], {
      importance: 'RECOMMENDED',
    }),
    choice('compatibility', 'Printer compatibility', [], { importance: 'RECOMMENDED' }),
    colour(['Black', 'Cyan', 'Magenta', 'Yellow', 'Tri-colour'], 'RECOMMENDED'),
    measure('page_yield', 'Page yield', ['pages'], { suggestions: ['1000', '1500', '2500', '5000', '10000'] }),
    choice('capacity_type', 'Capacity', ['Standard', 'High capacity', 'Extra high capacity'], {
      allowsCustomValues: false,
    }),
    packCount(['1', '2', '4', '5', '10']),
    choice('supply_type', 'Original or compatible', ['Original (OEM)', 'Compatible', 'Remanufactured']),
    choice('warranty', 'Warranty', ['6 months', '1 year'], { inTitle: false }),
  ]),
];

// ---------------------------------------------------------------------------
// 9. PACKAGING & SHIPPING
// ---------------------------------------------------------------------------

const PACKAGING: readonly VariantTemplate[] = [
  template('packaging-shipping', 'boxes-cartons', 'Boxes & Cartons', [
    choice('box_style', 'Style', ['Regular slotted (RSC)', 'Die cut', 'Telescopic', 'Postal box', 'Archive box'], {
      importance: 'RECOMMENDED',
    }),
    measure('internal_length', 'Internal length', ['mm', 'cm', 'in'], { importance: 'RECOMMENDED' }),
    measure('internal_width', 'Internal width', ['mm', 'cm', 'in'], { importance: 'RECOMMENDED' }),
    measure('internal_height', 'Internal height', ['mm', 'cm', 'in'], { importance: 'RECOMMENDED' }),
    material(['Single wall corrugated', 'Double wall corrugated', 'Solid board', 'Kraft']),
    choice('ply', 'Ply', ['3 ply', '5 ply', '7 ply'], { allowsCustomValues: false }),
    measure('load_rating', 'Strength or load rating', ['kg', 'ECT']),
    colour(['Brown', 'White', 'Printed']),
    packCount(['10', '25', '50', '100', '200']),
    flag('printed', 'Printing', ['Plain', 'Printed']),
    choice('flute', 'Flute', ['A flute', 'B flute', 'C flute', 'E flute', 'BC flute']),
  ]),

  template('packaging-shipping', 'tapes-strapping', 'Tapes & Strapping', [
    choice('tape_type', 'Type', ['BOPP packing tape', 'Masking tape', 'Duct tape', 'Double sided', 'PP strapping', 'PET strapping'], {
      importance: 'RECOMMENDED',
    }),
    measure('width', 'Width', ['mm'], { importance: 'RECOMMENDED', suggestions: ['12', '18', '24', '48', '72'] }),
    length(['m'], ['33', '50', '66', '100', '1000']),
    measure('thickness', 'Thickness', ['micron', 'mm'], { suggestions: ['40', '45', '50', '65'] }),
    colour(['Transparent', 'Brown', 'White', 'Black', 'Printed']),
    grade(['Standard', 'Heavy duty', 'Low noise'], 'Adhesive or tensile grade'),
    packCount(['1', '6', '12', '24', '36', '72']),
    choice('core_size', 'Core size', ['25 mm', '38 mm', '76 mm']),
    flag('printed', 'Printing', ['Plain', 'Printed']),
  ]),

  template('packaging-shipping', 'protective-packaging', 'Protective Packaging', [
    choice('product_type', 'Type', ['Bubble wrap', 'Foam sheet', 'Air pillow', 'Paper void fill', 'Corner protector'], {
      importance: 'RECOMMENDED',
    }),
    measure('width', 'Roll or sheet width', ['mm', 'm'], { importance: 'RECOMMENDED', suggestions: ['300', '500', '750', '1000', '1500'] }),
    length(['m'], ['10', '50', '100']),
    measure('thickness', 'Thickness', ['mm', 'micron']),
    choice('bubble_size', 'Bubble size or density', ['Small bubble', 'Large bubble', 'Low density', 'High density']),
    material(['LDPE', 'PE foam', 'Recycled paper', 'Biodegradable']),
    packCount(['1', '2', '4', '10']),
    flag('perforated', 'Perforation', ['Perforated', 'Continuous']),
    flag('antistatic', 'Antistatic', ['Antistatic', 'Standard']),
  ]),

  template('packaging-shipping', 'bags-films', 'Bags & Films', [
    choice('product_type', 'Type', ['Poly bag', 'Courier bag', 'Zip lock bag', 'Stretch film', 'Shrink film', 'Woven sack'], {
      importance: 'RECOMMENDED',
    }),
    measure('width', 'Width', ['mm', 'cm', 'in'], { importance: 'RECOMMENDED' }),
    length(['mm', 'cm', 'm'], ['200', '300', '400', '500']),
    measure('thickness', 'Thickness', ['micron', 'gauge'], { importance: 'RECOMMENDED', suggestions: ['20', '25', '40', '50', '100'] }),
    material(['LDPE', 'HDPE', 'LLDPE', 'PP woven', 'Compostable']),
    choice('closure', 'Closure', ['Open top', 'Self seal', 'Zip lock', 'Gusseted', 'Heat seal']),
    colour(['Clear', 'White', 'Black', 'Printed']),
    packCount(['50', '100', '500', '1000']),
    flag('printed', 'Printing', ['Plain', 'Printed']),
    flag('perforated', 'Perforation', ['Perforated', 'Continuous']),
  ]),

  template('packaging-shipping', 'labels-marking', 'Labels & Marking', [
    choice('label_type', 'Type', ['Address label', 'Barcode label', 'Thermal label', 'Warning label', 'Blank label'], {
      importance: 'RECOMMENDED',
    }),
    measure('label_size', 'Label size', ['mm'], { importance: 'RECOMMENDED', suggestions: ['38x21', '50x25', '100x50', '100x150'] }),
    choice('labels_per_unit', 'Labels per sheet or roll', ['1', '14', '21', '24', '500', '1000'], {
      importance: 'RECOMMENDED',
    }),
    material(['Paper', 'Polyester', 'Vinyl', 'Direct thermal', 'Thermal transfer']),
    choice('adhesive', 'Adhesive', ['Permanent', 'Removable', 'Freezer grade', 'High tack']),
    colour(['White', 'Yellow', 'Red', 'Transparent', 'Fluorescent']),
    choice('print_compatibility', 'Print compatibility', ['Laser', 'Inkjet', 'Thermal transfer', 'Direct thermal']),
    measure('core_size', 'Core size', ['mm', 'in'], { suggestions: ['25', '40', '76'] }),
    choice('shape', 'Shape', ['Rectangle', 'Square', 'Round', 'Oval']),
    flag('pre_printed', 'Printing', ['Blank', 'Pre-printed']),
  ]),
];

// ---------------------------------------------------------------------------
// 10. SAFETY & PROTECTIVE EQUIPMENT
// ---------------------------------------------------------------------------

const SAFETY: readonly VariantTemplate[] = [
  template('safety-protective-equipment', 'hand-protection', 'Hand Protection', [
    choice('glove_type', 'Type', ['Nitrile disposable', 'Latex disposable', 'Cut resistant', 'Leather rigger', 'Chemical resistant', 'Heat resistant'], {
      importance: 'RECOMMENDED',
    }),
    apparelSize(['XS', 'S', 'M', 'L', 'XL', '2XL']),
    material(['Nitrile', 'Latex', 'PU coated', 'Leather', 'HPPE', 'Neoprene']),
    choice('coating', 'Coating', ['Uncoated', 'Palm coated', 'Fully coated', 'Sandy finish']),
    choice('protection_rating', 'Protection rating', [], {
      importance: 'OPTIONAL',
    }),
    colour(['Blue', 'Black', 'White', 'Grey', 'Yellow']),
    choice('pair_count', 'Pairs supplied', ['1', '10', '12', '24']),
    packCount(['1', '10', '50', '100', '200']),
    choice('cuff_length', 'Cuff length', ['Wrist', 'Elbow', 'Shoulder', 'Gauntlet']),
    measure('thickness', 'Thickness', ['micron', 'mm'], { suggestions: ['2.5', '3.5', '4', '5'] }),
  ]),

  template('safety-protective-equipment', 'eye-face-protection', 'Eye & Face Protection', [
    choice('equipment_type', 'Type', ['Safety spectacles', 'Goggles', 'Face shield', 'Welding helmet'], {
      importance: 'RECOMMENDED',
    }),
    choice('lens_shade', 'Lens colour or shade', ['Clear', 'Smoke', 'Amber', 'Mirrored', 'Shade 5', 'Shade 9-13'], {
      importance: 'RECOMMENDED',
    }),
    choice('coating', 'Coating', ['Anti-scratch', 'Anti-fog', 'Both']),
    choice('fit', 'Frame or fit', ['Standard', 'Over-spectacle', 'Adjustable', 'Wraparound']),
    choice('protection_rating', 'Rating', []),
    packCount(['1', '10', '12', '24']),
    flag('prescription_compatible', 'Over spectacles', ['Over-spectacle', 'Standard']),
    choice('ventilation', 'Ventilation', ['Direct vent', 'Indirect vent', 'Non-vented']),
  ]),

  template('safety-protective-equipment', 'respiratory-protection', 'Respiratory Protection', [
    choice('mask_type', 'Type', ['Filtering facepiece', 'Half mask', 'Full face mask', 'Powered respirator', 'Filter cartridge'], {
      importance: 'RECOMMENDED',
    }),
    apparelSize(['S', 'M', 'L']),
    choice('filtration_class', 'Filtration class', ['FFP1', 'FFP2', 'FFP3', 'N95', 'P100', 'A1', 'ABEK1'], {
      importance: 'RECOMMENDED',
    }),
    flag('valve', 'Valve', ['Valved', 'Unvalved']),
    choice('reusability', 'Reusable or disposable', ['Disposable', 'Reusable'], { allowsCustomValues: false }),
    packCount(['1', '5', '10', '20', '50']),
    choice('head_attachment', 'Attachment', ['Ear loop', 'Head strap', 'Adjustable strap']),
    flag('nose_clip', 'Nose clip', ['With nose clip', 'Without']),
  ]),

  template('safety-protective-equipment', 'head-fall-protection', 'Head & Fall Protection', [
    choice('equipment_type', 'Type', ['Safety helmet', 'Bump cap', 'Full body harness', 'Lanyard', 'Fall arrest block'], {
      importance: 'RECOMMENDED',
    }),
    choice('size_range', 'Size', ['One size', 'S/M', 'M/L', 'L/XL', 'Universal'], { importance: 'RECOMMENDED' }),
    colour(['White', 'Yellow', 'Blue', 'Red', 'Orange'], 'RECOMMENDED'),
    material(['HDPE', 'ABS', 'Polyester webbing', 'Nylon webbing']),
    choice('protection_rating', 'Rating', []),
    choice('kit_configuration', 'Kit configuration', ['Item only', 'With lanyard', 'Complete kit']),
    choice('suspension', 'Suspension', ['4 point', '6 point', 'Ratchet', 'Pin lock']),
    flag('chin_strap', 'Chin strap', ['With chin strap', 'Without']),
  ]),

  template('safety-protective-equipment', 'protective-clothing', 'Protective Clothing', [
    choice('garment_type', 'Type', ['Coverall', 'Lab coat', 'Hi-vis vest', 'Apron', 'Sleeve protector'], {
      importance: 'RECOMMENDED',
    }),
    apparelSize(['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL']),
    material(['Polypropylene', 'SMS', 'Microporous', 'Cotton', 'Polyester cotton']),
    choice('protection_class', 'Protection class', ['Type 5/6', 'Type 4', 'Type 3', 'Class 1', 'Class 2', 'Class 3']),
    colour(['White', 'Blue', 'Yellow', 'Orange', 'Navy'], 'RECOMMENDED'),
    choice('reusability', 'Reusable or disposable', ['Disposable', 'Reusable'], { allowsCustomValues: false }),
    packCount(['1', '5', '10', '25', '50']),
    flag('hood', 'Hood', ['With hood', 'Without hood']),
    flag('antistatic', 'Antistatic', ['Antistatic', 'Standard']),
  ]),

  template('safety-protective-equipment', 'safety-footwear', 'Safety Footwear', [
    sizeSystem(['UK/India', 'EU', 'US']),
    numericSize(['5', '6', '7', '8', '9', '10', '11', '12', '13']),
    choice('width', 'Width fitting', ['Standard', 'Wide', 'Extra wide']),
    colour(['Black', 'Brown', 'Tan'], 'RECOMMENDED'),
    choice('toe_type', 'Toe cap', ['Steel toe', 'Composite toe', 'No toe cap']),
    material(['Full grain leather', 'Nubuck', 'Synthetic', 'Suede']),
    choice('sole_material', 'Sole', ['PU/PU', 'PU/Rubber', 'TPU', 'Nitrile rubber']),
    choice('safety_rating', 'Safety rating', ['S1', 'S1P', 'S3', 'SB', 'SBP']),
    choice('ankle_height', 'Ankle height', ['Low ankle', 'Mid ankle', 'High ankle']),
    closure(['Lace-up', 'Slip-on', 'Velcro', 'Buckle']),
    choice('sole_density', 'Sole density', ['Single density', 'Double density', 'Triple density']),
  ]),

  template('safety-protective-equipment', 'fire-safety-first-aid', 'Fire Safety & First Aid', [
    choice('product_type', 'Type', ['ABC extinguisher', 'CO2 extinguisher', 'Foam extinguisher', 'Fire blanket', 'First aid kit', 'Eyewash station'], {
      importance: 'RECOMMENDED',
    }),
    capacity(['kg', 'L', 'persons'], ['1', '2', '4', '6', '9', '10', '25', '50']),
    choice('content_level', 'Class or content level', ['Class A', 'Class ABC', 'Class BC', 'Small kit', 'Medium kit', 'Large kit']),
    choice('mounting', 'Mounting or case', ['Wall bracket', 'Vehicle bracket', 'Trolley', 'Hard case', 'Soft bag']),
    packCount(['1', '2', '4', '6']),
  ]),
];

// ---------------------------------------------------------------------------
// 11. CLEANING & HYGIENE
// ---------------------------------------------------------------------------

const CLEANING: readonly VariantTemplate[] = [
  template('cleaning-hygiene', 'cleaning-chemicals', 'Cleaning Chemicals', [
    choice('product_type', 'Type', ['Floor cleaner', 'Glass cleaner', 'Toilet cleaner', 'Degreaser', 'Dishwash liquid', 'Detergent powder'], {
      importance: 'RECOMMENDED',
    }),
    choice('formulation', 'Formulation', ['Liquid', 'Powder', 'Gel', 'Concentrate', 'Ready to use'], {
      importance: 'RECOMMENDED',
    }),
    choice('fragrance', 'Fragrance', ['Unscented', 'Lemon', 'Pine', 'Floral', 'Ocean']),
    measure('concentration', 'Concentration', ['%']),
    netVolume(['500', '1', '5', '20', '200']),
    choice('dilution_ratio', 'Dilution ratio', ['Ready to use', '1:10', '1:20', '1:50', '1:100']),
    choice('container_type', 'Container', ['Spray bottle', 'Bottle', 'Jerrycan', 'Drum', 'Sachet']),
    packCount(['1', '4', '6', '12']),
    choice('ph_type', 'pH', ['Acidic', 'Neutral', 'Alkaline']),
    flag('biodegradable', 'Biodegradable', ['Biodegradable', 'Standard']),
  ]),

  template('cleaning-hygiene', 'disinfection-sterilisation', 'Disinfection & Sterilisation', [
    choice('method_type', 'Type', ['Surface disinfectant', 'Hand sanitiser', 'Instrument disinfectant', 'UV steriliser', 'Autoclave'], {
      importance: 'RECOMMENDED',
    }),
    measure('concentration', 'Concentration or strength', ['%', 'ppm'], { importance: 'RECOMMENDED', suggestions: ['0.5', '70', '75', '80'] }),
    netVolume(['100', '500', '1', '5', '20']),
    choice('contact_time', 'Contact time grade', ['30 seconds', '1 minute', '5 minutes', '10 minutes']),
    capacity(['L', 'items'], ['12', '18', '23', '50']),
    packCount(['1', '6', '12', '24']),
    choice('application', 'Application', ['Surface', 'Hands', 'Instruments', 'Air', 'Fabric']),
    choice('form', 'Form', ['Liquid', 'Gel', 'Spray', 'Wipe', 'Tablet']),
  ]),

  template('cleaning-hygiene', 'cleaning-equipment', 'Cleaning Equipment', [
    choice('equipment_type', 'Type', ['Vacuum cleaner', 'Scrubber drier', 'Pressure washer', 'Mop and bucket', 'Sweeper'], {
      importance: 'RECOMMENDED',
    }),
    measure('working_width', 'Working width', ['mm', 'cm'], { suggestions: ['350', '430', '500', '700'] }),
    capacity(['L'], ['10', '15', '20', '30', '60']),
    measure('power', 'Power', ['W', 'kW'], { suggestions: ['1000', '1400', '1800', '2200'] }),
    voltage(),
    choice('attachments', 'Attachments', ['Standard set', 'Extended set', 'Machine only']),
    choice('operation', 'Operation', ['Walk behind', 'Ride on', 'Handheld', 'Backpack']),
    flag('wet_dry', 'Wet and dry', ['Wet and dry', 'Dry only']),
  ]),

  template('cleaning-hygiene', 'washroom-supplies', 'Washroom Supplies', [
    choice('product_type', 'Type', ['Toilet roll', 'Hand towel', 'Soap dispenser', 'Air freshener', 'Paper dispenser'], {
      importance: 'RECOMMENDED',
    }),
    measure('sheet_size', 'Roll, sheet or dispenser size', ['mm', 'm', 'sheets'], { importance: 'RECOMMENDED' }),
    choice('ply', 'Ply', ['1 ply', '2 ply', '3 ply'], { allowsCustomValues: false }),
    choice('fragrance', 'Fragrance', ['Unscented', 'Lemon', 'Lavender', 'Fresh']),
    colour(['White', 'Natural', 'Green', 'Blue']),
    packCount(['6', '10', '12', '24', '48']),
    flag('embossed', 'Finish', ['Embossed', 'Plain']),
    choice('dispenser_type', 'Dispenser type', ['Manual', 'Automatic', 'Pedal']),
  ]),

  template('cleaning-hygiene', 'waste-management', 'Waste Management', [
    choice('product_type', 'Type', ['Wheelie bin', 'Pedal bin', 'Bin liner', 'Recycling bin', 'Sharps container'], {
      importance: 'RECOMMENDED',
    }),
    capacity(['L'], ['20', '30', '50', '80', '120', '240', '660'], ),
    measure('dimensions', 'Dimensions', ['mm', 'cm']),
    material(['HDPE', 'LDPE', 'Stainless steel', 'Galvanised steel']),
    colour(['Black', 'Green', 'Blue', 'Yellow', 'Red'], 'RECOMMENDED'),
    choice('lid_type', 'Lid or segregation', ['Open top', 'Flap lid', 'Pedal lid', 'Swing lid', 'Colour coded']),
    packCount(['1', '10', '50', '100', '500']),
    flag('wheeled', 'Wheels', ['On wheels', 'No wheels']),
    choice('opening_type', 'Opening', ['Pedal operated', 'Manual lid', 'Open top']),
  ]),
];

export const COMMERCE_TEMPLATES: readonly VariantTemplate[] = Object.freeze([
  ...COMPUTERS,
  ...PHONES,
  ...OFFICE,
  ...PACKAGING,
  ...SAFETY,
  ...CLEANING,
]);
