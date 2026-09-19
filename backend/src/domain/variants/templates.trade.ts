/**
 * Variant templates: the six departments that fit out a building or a fleet.
 *
 * Building & Construction, Automotive & Transport, Agriculture & Gardening,
 * Food Service & Catering, Furniture & Fixtures, Home & Kitchen.
 *
 * The distinctive thing about this group is that several of its shelves are
 * sold by a measure rather than by the piece - cement by the bag, cable by the
 * reel, sand by the tonne, paint by the litre. The axis captures WHAT IS IN
 * ONE UNIT; how many units the buyer wants is cart quantity, and the two are
 * never the same field. A 25 kg bag ordered four times is four bags and 100
 * kg, not a 100 kg bag.
 *
 * Vehicle fitment is the other thing this group does that no other does. Make,
 * model and year range are axes when a seller genuinely lists one part number
 * per fitment; they are specifications when the part fits everything. Which of
 * the two it is, is the seller's answer, not ours.
 */
import { template, type VariantTemplate } from './axis.js';
import {
  capacity,
  choice,
  colour,
  diameter,
  finish,
  flag,
  fragrance,
  grade,
  length,
  material,
  measure,
  netVolume,
  netWeight,
  packCount,
  pieceCount,
  voltage,
} from './library.js';

// ---------------------------------------------------------------------------
// 12. BUILDING & CONSTRUCTION
// ---------------------------------------------------------------------------

const BUILDING: readonly VariantTemplate[] = [
  template('building-construction', 'building-materials', 'Building Materials', [
    choice('material_type', 'Type', ['Cement', 'Plywood', 'Gypsum board', 'Tile', 'Brick', 'Steel bar', 'Insulation'], {
      importance: 'RECOMMENDED',
    }),
    grade(['OPC 43', 'OPC 53', 'PPC', 'Fe500', 'Fe550', 'BWP', 'MR'], 'Grade or strength'),
    measure('dimensions', 'Dimensions', ['mm', 'cm', 'm', 'ft'], { importance: 'RECOMMENDED' }),
    measure('thickness', 'Thickness', ['mm'], { suggestions: ['6', '9', '12', '18', '25'] }),
    finish(['Matt', 'Glossy', 'Textured', 'Unfinished', 'Laminated']),
    choice('sale_unit', 'Sold as', ['Piece', 'Bag', 'Bundle', 'Square metre', 'Pallet', 'Tonne'], {
      importance: 'RECOMMENDED',
      allowsCustomValues: false,
    }),
    netWeight(['1', '25', '50'], 'Weight per unit'),
    choice('surface', 'Surface', ['Smooth', 'Textured', 'Anti-skid', 'Polished']),
    choice('application_area', 'Application', ['Interior', 'Exterior', 'Wet area', 'Structural']),
  ]),

  template('building-construction', 'plumbing-sanitary', 'Plumbing & Sanitary', [
    choice('component_type', 'Type', ['Pipe', 'Elbow', 'Tee', 'Tap', 'Valve', 'Trap', 'Cistern'], {
      importance: 'RECOMMENDED',
    }),
    measure('nominal_size', 'Nominal size', ['mm', 'in', 'DN'], {
      importance: 'RECOMMENDED',
      suggestions: ['15', '20', '25', '32', '40', '50', '63', '110'],
    }),
    material(['CPVC', 'UPVC', 'PPR', 'Copper', 'Brass', 'Stainless steel', 'Cast iron']),
    choice('pressure_class', 'Pressure class', ['SDR 11', 'SDR 13.5', 'Class B', 'Class C', 'PN10', 'PN16']),
    choice('connection_type', 'Connection', ['Threaded', 'Solvent weld', 'Push fit', 'Compression', 'Flanged']),
    length(['m', 'mm'], ['1', '2', '3', '6']),
    packCount(['1', '10', '25', '50', '100']),
    choice('application_area', 'Application', ['Cold water', 'Hot and cold', 'Drainage', 'Gas']),
    finish(['Chrome', 'Matt black', 'Brushed nickel', 'Antique brass', 'White']),
  ]),

  template('building-construction', 'heating-ventilation-cooling', 'Heating, Ventilation & Cooling', [
    choice('equipment_type', 'Type', ['Split air conditioner', 'Window air conditioner', 'Exhaust fan', 'Air handling unit', 'Heater', 'Duct'], {
      importance: 'RECOMMENDED',
    }),
    capacity(['ton', 'CFM', 'BTU', 'kW'], ['0.8', '1', '1.5', '2', '2.5']),
    voltage(),
    choice('phase', 'Phase', ['Single phase', 'Three phase']),
    measure('dimensions', 'Dimensions', ['mm', 'cm']),
    choice('efficiency_class', 'Efficiency class', ['3 star', '4 star', '5 star', 'A++', 'A+++']),
    choice('refrigerant', 'Refrigerant', ['R32', 'R410A', 'R290', 'R134a']),
    choice('mounting', 'Mounting', ['Wall mounted', 'Window', 'Cassette', 'Floor standing', 'Ducted']),
    flag('inverter', 'Compressor', ['Inverter', 'Non-inverter']),
  ]),

  template('building-construction', 'paint-surface-finishing', 'Paint & Surface Finishing', [
    choice('product_type', 'Type', ['Emulsion', 'Enamel', 'Primer', 'Wood finish', 'Waterproofing', 'Putty'], {
      importance: 'RECOMMENDED',
    }),
    finish(['Matt', 'Satin', 'Semi-gloss', 'High gloss', 'Textured']),
    colour(['White', 'Off white', 'Grey', 'Custom tinted'], 'RECOMMENDED'),
    choice('base', 'Base', ['Water based', 'Solvent based', 'White base', 'Deep base'], {
      importance: 'RECOMMENDED',
    }),
    netVolume(['500', '1', '4', '10', '20'], 'Pack volume'),
    measure('coverage', 'Coverage', ['m2/L', 'sq ft/L']),
    choice('use_location', 'Interior or exterior', ['Interior', 'Exterior', 'Interior and exterior'], {
      allowsCustomValues: false,
    }),
    choice('application_method', 'Applied by', ['Brush', 'Roller', 'Spray']),
    choice('drying_time', 'Drying time', ['30 minutes', '1 hour', '4 hours', 'Overnight']),
  ]),

  template('building-construction', 'doors-windows-ironmongery', 'Doors, Windows & Ironmongery', [
    choice('product_type', 'Type', ['Flush door', 'Panel door', 'uPVC window', 'Door handle', 'Mortice lock', 'Hinge'], {
      importance: 'RECOMMENDED',
    }),
    measure('dimensions', 'Dimensions', ['mm', 'ft'], { importance: 'RECOMMENDED' }),
    choice('handing', 'Handing', ['Left hand', 'Right hand', 'Reversible', 'Not applicable']),
    material(['Solid wood', 'Engineered wood', 'uPVC', 'Aluminium', 'Stainless steel', 'Brass']),
    finish(['Satin chrome', 'Polished brass', 'Matt black', 'Anodised', 'Laminated']),
    colour(['White', 'Brown', 'Black', 'Teak', 'Walnut']),
    measure('backset', 'Lock or backset', ['mm'], { suggestions: ['45', '57', '60'] }),
    packCount(['1', '2', '5', '10', '20']),
    choice('opening_type', 'Opening', ['Hinged', 'Sliding', 'Folding', 'Fixed']),
    choice('glazing', 'Glazing', ['Unglazed', 'Single glazed', 'Double glazed', 'Frosted']),
  ]),
];

// ---------------------------------------------------------------------------
// 13. AUTOMOTIVE & TRANSPORT
// ---------------------------------------------------------------------------

const AUTOMOTIVE: readonly VariantTemplate[] = [
  template('automotive-transport', 'vehicle-parts', 'Vehicle Parts', [
    choice('part_type', 'Part type', ['Brake pad', 'Oil filter', 'Air filter', 'Clutch plate', 'Shock absorber', 'Headlamp'], {
      importance: 'RECOMMENDED',
    }),
    choice('vehicle_make', 'Vehicle make', [], { importance: 'RECOMMENDED' }),
    choice('vehicle_model', 'Vehicle model', [], { importance: 'RECOMMENDED', dependsOn: ['vehicle_make'] }),
    choice('year_range', 'Year range', [], { dependsOn: ['vehicle_model'] }),
    choice('engine_trim', 'Engine or trim', []),
    choice('position', 'Position', ['Front', 'Rear', 'Front left', 'Front right', 'Rear left', 'Rear right']),
    choice('part_origin', 'OEM or aftermarket', ['OEM', 'OES', 'Aftermarket'], { allowsCustomValues: false }),
    packCount(['1', '2', '4', '10']),
    choice('fuel_type', 'Fuel type', ['Petrol', 'Diesel', 'CNG', 'Electric']),
    choice('warranty', 'Warranty', ['6 months', '1 year', '2 years'], { inTitle: false }),
  ]),

  template('automotive-transport', 'tyres-wheels', 'Tyres & Wheels', [
    choice('tyre_size', 'Tyre size', ['165/80 R14', '175/65 R15', '195/55 R16', '205/55 R16', '215/60 R17'], {
      importance: 'RECOMMENDED',
    }),
    measure('section_width', 'Section width', ['mm'], { suggestions: ['145', '155', '165', '175', '185', '195', '205', '215'] }),
    measure('aspect_ratio', 'Aspect ratio', ['%'], { suggestions: ['45', '50', '55', '60', '65', '70', '80'] }),
    measure('rim_diameter', 'Rim diameter', ['in'], { suggestions: ['12', '13', '14', '15', '16', '17', '18'] }),
    choice('load_index', 'Load index', ['79', '82', '84', '88', '91', '94']),
    choice('speed_rating', 'Speed rating', ['S', 'T', 'H', 'V', 'W', 'Y'], { allowsCustomValues: false }),
    choice('tube_type', 'Tubeless or tube type', ['Tubeless', 'Tube type'], { allowsCustomValues: false }),
    measure('wheel_width', 'Wheel width', ['in'], { suggestions: ['5', '5.5', '6', '6.5', '7'] }),
    choice('pcd', 'PCD', ['4x100', '4x108', '5x100', '5x112', '5x114.3']),
    packCount(['1', '2', '4', '5']),
    choice('season', 'Use', ['All season', 'Summer', 'Winter', 'Off road']),
    choice('construction', 'Construction', ['Radial', 'Bias ply']),
  ]),

  template('automotive-transport', 'garage-equipment', 'Garage Equipment', [
    choice('equipment_type', 'Type', ['Two-post lift', 'Trolley jack', 'Tyre changer', 'Wheel balancer', 'Air compressor', 'Diagnostic scanner'], {
      importance: 'RECOMMENDED',
    }),
    measure('load_capacity', 'Capacity', ['t', 'kg', 'L'], { importance: 'RECOMMENDED', suggestions: ['2', '3', '3.5', '4', '5'] }),
    measure('dimensions', 'Dimensions', ['mm', 'cm']),
    voltage(),
    choice('phase', 'Phase', ['Single phase', 'Three phase']),
    choice('kit_contents', 'Kit contents', ['Machine only', 'With accessories', 'Complete kit']),
    choice('operation', 'Operation', ['Manual', 'Hydraulic', 'Pneumatic', 'Electric']),
    choice('mounting', 'Mounting', ['Floor standing', 'Portable', 'Wall mounted']),
  ]),

  template('automotive-transport', 'vehicle-care', 'Vehicle Care', [
    choice('product_type', 'Type', ['Car shampoo', 'Polish', 'Ceramic coating', 'Dashboard cleaner', 'Tyre shine', 'Engine oil'], {
      importance: 'RECOMMENDED',
    }),
    choice('formulation', 'Formulation', ['Liquid', 'Paste', 'Spray', 'Foam', 'Wipe']),
    netVolume(['100', '250', '500', '1', '5'], 'Pack volume'),
    colour(['Clear', 'Black', 'White', 'Silver']),
    choice('applicator', 'Applicator', ['Bottle only', 'With applicator pad', 'With microfibre cloth']),
    packCount(['1', '2', '6', '12']),
    choice('surface', 'For surface', ['Paint', 'Glass', 'Plastic trim', 'Leather', 'Fabric', 'Alloy wheel']),
    fragrance(['Unscented', 'Lemon', 'Vanilla', 'Ocean', 'New car']),
  ]),
];

// ---------------------------------------------------------------------------
// 14. AGRICULTURE & GARDENING
// ---------------------------------------------------------------------------

const AGRICULTURE: readonly VariantTemplate[] = [
  template('agriculture-gardening', 'farm-equipment', 'Farm Equipment', [
    choice('equipment_type', 'Type', ['Rotavator', 'Seed drill', 'Sprayer', 'Thresher', 'Chaff cutter', 'Power tiller'], {
      importance: 'RECOMMENDED',
    }),
    capacity(['L', 'kg', 'hp'], ['16', '20', '50', '100']),
    measure('power', 'Power', ['hp', 'kW'], { importance: 'RECOMMENDED', suggestions: ['5', '7', '9', '35', '45', '50'] }),
    measure('working_width', 'Working width', ['mm', 'ft', 'm']),
    choice('hitch_compatibility', 'Hitch or machine compatibility', ['Category I', 'Category II', 'Three point linkage', 'Trailed']),
    choice('power_source', 'Fuel or power', ['Diesel', 'Petrol', 'PTO driven', 'Electric', 'Battery']),
    choice('attachments', 'Included attachments', ['Machine only', 'With standard attachments', 'Full set']),
    choice('operation', 'Operation', ['Manual', 'Tractor mounted', 'Self propelled', 'Battery operated']),
    measure('tank_capacity', 'Tank capacity', ['L'], { suggestions: ['8', '12', '16', '20'] }),
  ]),

  template('agriculture-gardening', 'irrigation', 'Irrigation', [
    choice('component_type', 'Type', ['Drip line', 'Sprinkler', 'Emitter', 'Filter', 'Valve', 'Lay flat pipe'], {
      importance: 'RECOMMENDED',
    }),
    diameter(['mm', 'in'], ['12', '16', '20', '25', '32', '50', '63']),
    length(['m'], ['50', '100', '200', '400']),
    measure('flow_rate', 'Flow rate', ['L/h', 'L/min'], { suggestions: ['2', '4', '8', '16'] }),
    measure('pressure_rating', 'Pressure rating', ['bar', 'kg/cm2'], { suggestions: ['2.5', '4', '6'] }),
    choice('connection_type', 'Connection', ['Push fit', 'Threaded', 'Barbed', 'Compression']),
    packCount(['1', '10', '50', '100', '500']),
    choice('spacing', 'Emitter spacing', ['20 cm', '30 cm', '40 cm', '50 cm']),
    flag('uv_stabilised', 'UV stabilised', ['UV stabilised', 'Standard']),
  ]),

  template('agriculture-gardening', 'seeds-feed-fertiliser', 'Seeds, Feed & Fertiliser', [
    choice('product_type', 'Product or crop', ['Vegetable seed', 'Flower seed', 'Cattle feed', 'Poultry feed', 'NPK fertiliser', 'Organic manure'], {
      importance: 'RECOMMENDED',
    }),
    choice('variety', 'Variety', [], { importance: 'RECOMMENDED' }),
    grade(['Certified', 'Foundation', 'Truthfully labelled', 'Standard'], 'Grade'),
    choice('form', 'Form', ['Seed', 'Granule', 'Powder', 'Liquid', 'Pellet']),
    choice('treatment', 'Treatment', ['Untreated', 'Treated', 'Coated', 'Primed']),
    choice('organic_status', 'Organic status', ['Certified organic', 'Not certified'], {
      allowsCustomValues: false,
      inTitle: false,
    }),
    netWeight(['100', '250', '500', '1', '5', '10', '25'], 'Net weight'),
    packCount(['1', '5', '10', '20']),
    choice('season', 'Season', ['Kharif', 'Rabi', 'Summer', 'All season']),
    measure('germination', 'Germination', ['%'], { suggestions: ['70', '80', '85', '90'] }),
    choice('hybrid_type', 'Type', ['Hybrid', 'Open pollinated', 'Heirloom']),
  ]),

  template('agriculture-gardening', 'garden-tools-outdoor', 'Garden Tools & Outdoor', [
    choice('product_type', 'Type', ['Lawn mower', 'Hedge trimmer', 'Secateurs', 'Spade', 'Hose reel', 'Wheelbarrow'], {
      importance: 'RECOMMENDED',
    }),
    measure('size', 'Size or length', ['mm', 'cm', 'm', 'in'], { importance: 'RECOMMENDED' }),
    material(['Carbon steel', 'Stainless steel', 'Aluminium', 'Plastic', 'Wood handle']),
    choice('power_source', 'Power source', ['Manual', 'Electric', 'Battery', 'Petrol']),
    capacity(['L', 'cc'], ['20', '40', '60', '100']),
    colour(['Green', 'Black', 'Red', 'Orange']),
    choice('kit_configuration', 'Kit configuration', ['Tool only', 'With battery', 'Full kit']),
    choice('handle_type', 'Handle', ['Wooden', 'Fibreglass', 'Steel', 'Telescopic']),
    measure('cutting_width', 'Cutting width', ['mm', 'cm', 'in']),
  ]),
];

// ---------------------------------------------------------------------------
// 15. FOOD SERVICE & CATERING
// ---------------------------------------------------------------------------

const FOOD_SERVICE: readonly VariantTemplate[] = [
  template('food-service-catering', 'commercial-kitchen-equipment', 'Commercial Kitchen Equipment', [
    choice('equipment_type', 'Type', ['Convection oven', 'Deep fryer', 'Griddle', 'Dishwasher', 'Planetary mixer', 'Induction range'], {
      importance: 'RECOMMENDED',
    }),
    capacity(['L', 'kg', 'trays', 'covers'], ['5', '10', '20', '40', '60']),
    measure('power', 'Power', ['kW', 'W'], { suggestions: ['2.5', '5', '9', '12'] }),
    voltage(),
    choice('phase', 'Phase', ['Single phase', 'Three phase']),
    measure('dimensions', 'Dimensions', ['mm', 'cm'], { importance: 'RECOMMENDED' }),
    material(['Stainless steel 304', 'Stainless steel 202', 'Mild steel', 'Aluminium']),
    choice('configuration', 'Configuration', ['Countertop', 'Freestanding', 'Built-in', 'Mobile']),
    choice('fuel_type', 'Fuel', ['Electric', 'LPG', 'PNG', 'Diesel']),
    flag('castors', 'Castors', ['On castors', 'On legs']),
  ]),

  template('food-service-catering', 'tableware-serving', 'Tableware & Serving', [
    choice('item_type', 'Item', ['Dinner plate', 'Bowl', 'Cup', 'Tumbler', 'Cutlery set', 'Serving tray'], {
      importance: 'RECOMMENDED',
    }),
    material(['Bone china', 'Porcelain', 'Melamine', 'Stainless steel', 'Glass', 'Wood']),
    measure('size', 'Diameter, size or capacity', ['mm', 'cm', 'in', 'ml'], { importance: 'RECOMMENDED' }),
    colour(['White', 'Ivory', 'Black', 'Blue', 'Assorted']),
    choice('pattern', 'Pattern', ['Plain', 'Banded', 'Floral', 'Printed']),
    pieceCount(['1', '6', '12', '18', '24'], 'Pieces in set'),
    packCount(['1', '6', '12', '24']),
    flag('microwave_safe', 'Microwave safe', ['Microwave safe', 'Not microwave safe']),
    flag('dishwasher_safe', 'Dishwasher safe', ['Dishwasher safe', 'Hand wash only']),
  ]),

  template('food-service-catering', 'disposables-takeaway', 'Disposables & Takeaway', [
    choice('item_type', 'Item', ['Food container', 'Cup', 'Plate', 'Cutlery', 'Carry bag', 'Straw'], {
      importance: 'RECOMMENDED',
    }),
    capacity(['ml', 'g'], ['150', '250', '350', '500', '750', '1000']),
    material(['Polypropylene', 'Bagasse', 'Paper', 'Aluminium', 'PLA (compostable)']),
    colour(['White', 'Natural', 'Black', 'Brown', 'Transparent']),
    choice('compartments', 'Compartments', ['1', '2', '3', '4', '5']),
    choice('lid', 'Lid', ['With lid', 'Without lid', 'Lid only'], { allowsCustomValues: false }),
    packCount(['25', '50', '100', '500', '1000']),
    flag('microwave_safe', 'Microwave safe', ['Microwave safe', 'Not microwave safe']),
    flag('compostable', 'Compostable', ['Compostable', 'Standard']),
  ]),

  template('food-service-catering', 'food-storage-refrigeration', 'Food Storage & Refrigeration', [
    choice('equipment_type', 'Type', ['Under-counter fridge', 'Upright freezer', 'Display chiller', 'Food container', 'Insulated carrier'], {
      importance: 'RECOMMENDED',
    }),
    capacity(['L', 'ml', 'kg'], ['1', '5', '100', '250', '400', '600']),
    measure('temperature_range', 'Temperature range', ['C'], { suggestions: ['2 to 8', '-18 to -22', '0 to 4'] }),
    measure('dimensions', 'Dimensions', ['mm', 'cm']),
    measure('power', 'Power', ['W'], { suggestions: ['150', '250', '400'] }),
    choice('door_count', 'Doors', ['1', '2', '3', '4']),
    choice('configuration', 'Configuration', ['Solid door', 'Glass door', 'Drawer', 'Chest']),
    flag('airtight', 'Seal', ['Airtight', 'Standard lid']),
    choice('defrost', 'Defrost', ['Manual defrost', 'Frost free']),
  ]),
];

// ---------------------------------------------------------------------------
// 16. FURNITURE & FIXTURES
// ---------------------------------------------------------------------------

const FURNITURE: readonly VariantTemplate[] = [
  template('furniture-fixtures', 'office-furniture', 'Office Furniture', [
    choice('product_type', 'Type', ['Desk', 'Workstation', 'Pedestal', 'Conference table', 'Reception counter'], {
      importance: 'RECOMMENDED',
    }),
    measure('dimensions', 'Dimensions', ['mm', 'cm', 'ft'], { importance: 'RECOMMENDED' }),
    material(['Engineered wood', 'Solid wood', 'Steel', 'Glass', 'Laminate']),
    finish(['Matt laminate', 'High gloss', 'Veneer', 'Powder coated']),
    colour(['Oak', 'Walnut', 'White', 'Grey', 'Black'], 'RECOMMENDED'),
    choice('configuration', 'Configuration', ['Straight', 'L-shaped', 'With storage', 'Height adjustable']),
    choice('assembly', 'Assembly', ['Flat pack', 'Pre-assembled'], { allowsCustomValues: false }),
    choice('edge_type', 'Edge', ['PVC edge band', 'Post formed', 'Bull nose']),
    flag('cable_management', 'Cable management', ['With cable management', 'Without']),
  ]),

  template('furniture-fixtures', 'seating', 'Seating', [
    choice('seating_type', 'Type', ['Task chair', 'Executive chair', 'Visitor chair', 'Stool', 'Sofa', 'Bench'], {
      importance: 'RECOMMENDED',
    }),
    measure('dimensions', 'Dimensions', ['mm', 'cm']),
    material(['Mesh', 'Fabric', 'Leatherette', 'Genuine leather', 'Polypropylene']),
    colour(['Black', 'Grey', 'Blue', 'Beige', 'Red'], 'RECOMMENDED'),
    choice('frame', 'Frame or base', ['Nylon base', 'Aluminium base', 'Chrome base', 'Fixed legs', 'Sled base']),
    choice('adjustments', 'Adjustments', ['Fixed', 'Height adjustable', 'Synchro tilt', 'Multi-function']),
    measure('weight_capacity', 'Weight capacity', ['kg'], { suggestions: ['100', '120', '150', '180'] }),
    choice('armrest', 'Armrest', ['Fixed', 'Adjustable', 'None', '3D adjustable']),
    flag('headrest', 'Headrest', ['With headrest', 'Without headrest']),
    flag('lumbar_support', 'Lumbar support', ['With lumbar support', 'Without']),
  ]),

  template('furniture-fixtures', 'storage-shelving', 'Storage & Shelving', [
    choice('product_type', 'Type', ['Slotted angle rack', 'Pallet rack', 'Cupboard', 'Filing cabinet', 'Locker'], {
      importance: 'RECOMMENDED',
    }),
    measure('dimensions', 'Dimensions', ['mm', 'ft'], { importance: 'RECOMMENDED' }),
    choice('shelf_count', 'Shelves or drawers', ['2', '3', '4', '5', '6', '8']),
    measure('load_capacity', 'Load capacity per shelf', ['kg'], { suggestions: ['50', '100', '150', '200', '500'] }),
    material(['Mild steel', 'Stainless steel', 'Engineered wood', 'Plastic']),
    finish(['Powder coated', 'Galvanised', 'Laminated']),
    colour(['Grey', 'Blue', 'Black', 'Beige']),
    flag('lockable', 'Locking', ['Lockable', 'Not lockable']),
    flag('adjustable_shelves', 'Shelves', ['Adjustable', 'Fixed']),
  ]),

  template('furniture-fixtures', 'retail-display', 'Retail Display', [
    choice('fixture_type', 'Type', ['Gondola', 'Wall unit', 'Slatwall panel', 'Display counter', 'Mannequin', 'Hanging rail'], {
      importance: 'RECOMMENDED',
    }),
    measure('dimensions', 'Dimensions', ['mm', 'ft'], { importance: 'RECOMMENDED' }),
    material(['Mild steel', 'MDF', 'Acrylic', 'Glass', 'Aluminium']),
    finish(['Powder coated', 'Laminated', 'Anodised', 'Painted']),
    choice('shelf_count', 'Shelves or hooks', ['2', '3', '4', '5', '6']),
    measure('load_capacity', 'Load capacity', ['kg']),
    choice('configuration', 'Configuration', ['Starter bay', 'Add-on bay', 'Island', 'Corner']),
    flag('lighting_included', 'Lighting', ['With lighting', 'Without lighting']),
    flag('castors', 'Castors', ['On castors', 'Fixed']),
  ]),
];

// ---------------------------------------------------------------------------
// 17. HOME & KITCHEN
// ---------------------------------------------------------------------------

const HOME: readonly VariantTemplate[] = [
  template('home-kitchen', 'kitchenware', 'Kitchenware', [
    choice('item_type', 'Item', ['Frying pan', 'Saucepan', 'Pressure cooker', 'Kadai', 'Casserole', 'Knife'], {
      importance: 'RECOMMENDED',
    }),
    measure('size', 'Diameter or capacity', ['cm', 'mm', 'L', 'ml'], {
      importance: 'RECOMMENDED',
      suggestions: ['18', '20', '24', '26', '28', '3', '5'],
    }),
    material(['Stainless steel', 'Hard anodised', 'Cast iron', 'Non-stick aluminium', 'Copper']),
    choice('coating', 'Coating', ['Uncoated', 'PTFE non-stick', 'Ceramic non-stick', 'Enamel']),
    colour(['Silver', 'Black', 'Red', 'Blue']),
    flag('induction', 'Induction compatible', ['Induction compatible', 'Gas only']),
    pieceCount(['1', '2', '3', '5', '7'], 'Pieces in set'),
    choice('handle_material', 'Handle material', ['Bakelite', 'Stainless steel', 'Wood', 'Silicone', 'Cast iron']),
    flag('lid_included', 'Lid', ['With lid', 'Without lid']),
    flag('dishwasher_safe', 'Dishwasher safe', ['Dishwasher safe', 'Hand wash only']),
  ]),

  template('home-kitchen', 'home-appliances', 'Home Appliances', [
    choice('appliance_type', 'Type', ['Mixer grinder', 'Washing machine', 'Refrigerator', 'Microwave', 'Water purifier', 'Fan'], {
      importance: 'RECOMMENDED',
    }),
    capacity(['L', 'kg', 'jars'], ['6', '7', '8', '190', '250', '500']),
    measure('power', 'Wattage', ['W'], { suggestions: ['500', '750', '1000', '1200'] }),
    voltage(),
    colour(['White', 'Black', 'Silver', 'Grey'], 'RECOMMENDED'),
    choice('efficiency_class', 'Energy rating', ['3 star', '4 star', '5 star']),
    choice('configuration', 'Configuration', ['Single door', 'Double door', 'Front load', 'Top load']),
    flag('inverter', 'Technology', ['Inverter', 'Non-inverter']),
    choice('warranty', 'Warranty', ['1 year', '2 years', '5 years', '10 years'], { inTitle: false }),
  ]),

  template('home-kitchen', 'bedding-bath', 'Bedding & Bath', [
    choice('item_type', 'Item', ['Bedsheet set', 'Duvet cover', 'Pillow', 'Towel', 'Bath mat', 'Blanket'], {
      importance: 'RECOMMENDED',
    }),
    choice('bed_size', 'Bed or garment size', ['Single', 'Double', 'Queen', 'King', 'Super king'], {
      importance: 'RECOMMENDED',
    }),
    measure('dimensions', 'Dimensions', ['cm', 'in'], { suggestions: ['150x225', '228x254', '274x274'] }),
    material(['100% cotton', 'Cotton blend', 'Microfibre', 'Linen', 'Bamboo']),
    measure('thread_count', 'GSM or thread count', ['gsm', 'TC'], { suggestions: ['144', '200', '300', '400', '500'] }),
    colour(['White', 'Ivory', 'Grey', 'Navy', 'Multicolour'], 'RECOMMENDED'),
    choice('pattern', 'Pattern', ['Plain', 'Striped', 'Floral', 'Geometric', 'Printed']),
    pieceCount(['1', '2', '3', '4', '6'], 'Pieces in set'),
    flag('reversible', 'Reversible', ['Reversible', 'Single sided']),
    choice('weave', 'Weave', ['Percale', 'Sateen', 'Poplin', 'Flannel', 'Terry']),
  ]),

  template('home-kitchen', 'home-decor', 'Home Decor', [
    choice('product_type', 'Type', ['Wall art', 'Vase', 'Cushion cover', 'Curtain', 'Photo frame', 'Table lamp'], {
      importance: 'RECOMMENDED',
    }),
    measure('dimensions', 'Dimensions', ['cm', 'in', 'mm'], { importance: 'RECOMMENDED' }),
    material(['Wood', 'Metal', 'Ceramic', 'Glass', 'Cotton', 'Polyester']),
    colour(['Natural', 'White', 'Black', 'Gold', 'Multicolour'], 'RECOMMENDED'),
    finish(['Matt', 'Glossy', 'Distressed', 'Antique']),
    choice('pattern', 'Pattern or style', ['Modern', 'Traditional', 'Abstract', 'Botanical']),
    pieceCount(['1', '2', '3', '4', '6'], 'Pieces in set'),
    flag('framed', 'Framing', ['Framed', 'Unframed']),
    choice('mounting', 'Mounting', ['Wall mounted', 'Table top', 'Free standing', 'Hanging']),
  ]),
];

export const TRADE_TEMPLATES: readonly VariantTemplate[] = Object.freeze([
  ...BUILDING,
  ...AUTOMOTIVE,
  ...AGRICULTURE,
  ...FOOD_SERVICE,
  ...FURNITURE,
  ...HOME,
]);
