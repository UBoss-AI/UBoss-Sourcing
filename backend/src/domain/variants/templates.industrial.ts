/**
 * Variant templates: the five technical departments.
 *
 * Laboratory & Scientific, Industrial Supplies, Tools & Hardware,
 * Electrical & Lighting, Electronics & Components.
 *
 * Every axis here is a CANDIDATE. A template is a list of the dimensions along
 * which items in this shelf are commonly stocked in more than one form - it is
 * not a form the seller has to fill in. A seller who stocks one grit of one
 * disc switches nothing on, and their product has one SKU and no selector.
 *
 * Batch numbers, expiry dates and certificates are conspicuously absent, and
 * that is deliberate. A 500 ml bottle of AR-grade acetone is the same variant
 * whichever batch it came out of; the batch belongs to the stock in the
 * warehouse, not to the identity of the thing being sold. Making it an axis
 * would give a catalogue a new SKU every delivery.
 */
import { template, type VariantTemplate } from './axis.js';
import {
  capacity,
  choice,
  colour,
  diameter,
  finish,
  flag,
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
// 1. LABORATORY & SCIENTIFIC
// ---------------------------------------------------------------------------

const LABORATORY: readonly VariantTemplate[] = [
  template('laboratory-scientific', 'lab-instruments', 'Lab Instruments', [
    choice('model', 'Model', [], { importance: 'RECOMMENDED' }),
    measure('measurement_range', 'Measurement range', ['g', 'kg', 'rpm', 'C', 'ml'], {
      importance: 'RECOMMENDED',
    }),
    capacity(['ml', 'L', 'g', 'tubes'], ['8', '12', '24']),
    measure('accuracy', 'Accuracy', ['g', 'mg', '%', 'C']),
    measure('resolution', 'Resolution', ['g', 'mg', 'ml', 'C']),
    measure('sample_capacity', 'Tube or sample capacity', ['tubes', 'wells', 'slots'], {
      suggestions: ['8', '12', '24', '48', '96'],
    }),
    voltage(),
    choice('plug_type', 'Plug type', ['Type C (EU)', 'Type G (UK)', 'Type D (IN)', 'Type A/B (US)']),
    choice('kit_configuration', 'Kit configuration', ['Instrument only', 'With starter kit', 'Full kit']),
    choice('display', 'Display', ['Analogue', 'Digital', 'Touchscreen']),
    choice('certification_supplied', 'Certificate supplied', ['None', 'Calibration certificate', 'Test report']),
  ]),

  template('laboratory-scientific', 'lab-glassware-plasticware', 'Glassware & Plasticware', [
    choice('item_type', 'Item type', ['Beaker', 'Flask', 'Measuring cylinder', 'Petri dish', 'Test tube', 'Pipette'], {
      importance: 'RECOMMENDED',
    }),
    material(['Borosilicate glass', 'Soda-lime glass', 'Polypropylene (PP)', 'HDPE', 'PTFE', 'PMP']),
    capacity(['ml', 'L'], ['10', '25', '50', '100', '250', '500', '1000']),
    choice('graduation', 'Graduation', ['Graduated', 'Ungraduated', 'Class A', 'Class B']),
    choice('neck_type', 'Neck or closure', ['Narrow neck', 'Wide neck', 'Screw cap', 'Ground joint', 'Open']),
    colour(['Clear', 'Amber', 'White', 'Natural']),
    packCount(['1', '6', '12', '24', '48']),
    flag('autoclavable', 'Autoclavable', ['Autoclavable', 'Not autoclavable']),
    choice('base_type', 'Base', ['Flat bottom', 'Round bottom', 'Conical']),
  ]),

  template('laboratory-scientific', 'lab-reagents-chemicals', 'Reagents & Chemicals', [
    grade(['AR', 'ACS', 'HPLC', 'LR', 'Technical', 'USP'], 'Reagent grade'),
    measure('purity', 'Purity', ['%'], { suggestions: ['95', '98', '99', '99.5', '99.9'] }),
    measure('concentration', 'Concentration', ['%', 'M', 'N', 'mg/ml']),
    choice('physical_form', 'Physical form', ['Powder', 'Liquid', 'Crystal', 'Granule', 'Solution']),
    netWeight(['25', '100', '500', '1', '2.5', '25']),
    netVolume(['100', '250', '500', '1', '2.5', '5']),
    choice('container_type', 'Container', ['Amber glass bottle', 'Clear glass bottle', 'HDPE bottle', 'Drum', 'Carboy']),
    choice('cas_form', 'Supplied as', ['Ready to use', 'Concentrate', 'Kit']),
    choice('storage', 'Storage', ['Room temperature', '2-8 C', 'Below -20 C']),
  ]),

  template('laboratory-scientific', 'lab-consumables-sampling', 'Consumables & Sampling', [
    choice('consumable_type', 'Consumable type', ['Pipette tip', 'Centrifuge tube', 'Swab', 'Syringe filter', 'Sample container'], {
      importance: 'RECOMMENDED',
    }),
    measure('dimensions', 'Dimensions', ['mm', 'cm']),
    measure('volume', 'Volume', ['ml', 'ul', 'L'], { suggestions: ['0.5', '1', '2', '5', '10', '15', '50'] }),
    material(['Polypropylene (PP)', 'Polystyrene (PS)', 'PTFE', 'Nylon', 'Cellulose acetate']),
    flag('sterility', 'Sterility', ['Sterile', 'Non-sterile']),
    choice('compatibility', 'Compatibility', []),
    packCount(['50', '100', '250', '500', '1000']),
    flag('filtered', 'Filter', ['Filtered', 'Unfiltered']),
    choice('graduation', 'Graduation', ['Graduated', 'Ungraduated']),
  ]),

  template('laboratory-scientific', 'measurement-calibration', 'Measurement & Calibration', [
    choice('measured_parameter', 'Measured parameter', ['Temperature', 'Pressure', 'pH', 'Humidity', 'Conductivity', 'Flow'], {
      importance: 'RECOMMENDED',
    }),
    measure('measurement_range', 'Range', ['C', 'bar', 'pH', '%RH', 'uS/cm']),
    choice('accuracy_class', 'Accuracy class', ['Class 0.1', 'Class 0.5', 'Class 1', 'Class 2']),
    measure('resolution', 'Resolution', ['C', 'bar', 'pH', '%']),
    choice('probe_type', 'Probe type', ['Integrated', 'External', 'Immersion', 'Surface', 'Penetration']),
    choice('connection', 'Connection', ['BNC', 'DIN', 'USB', 'Bluetooth', 'RS-232']),
    choice('calibration_option', 'Calibration supplied', ['Factory calibrated', 'With calibration certificate', 'Uncalibrated'], {
      importance: 'OPTIONAL',
    }),
    voltage(),
    choice('display', 'Display', ['Analogue', 'Digital', 'Backlit digital']),
    choice('power_source', 'Power source', ['Battery', 'Mains', 'USB', 'Solar']),
  ]),
];

// ---------------------------------------------------------------------------
// 2. INDUSTRIAL SUPPLIES
// ---------------------------------------------------------------------------

const INDUSTRIAL: readonly VariantTemplate[] = [
  template('industrial-supplies', 'fasteners-fixings', 'Fasteners & Fixings', [
    choice('fastener_type', 'Type', ['Hex bolt', 'Socket screw', 'Machine screw', 'Nut', 'Washer', 'Anchor', 'Rivet'], {
      importance: 'RECOMMENDED',
    }),
    choice('thread_system', 'Thread system', ['Metric', 'Imperial (UNC)', 'Imperial (UNF)', 'BSW', 'BSP'], {
      allowsCustomValues: false,
    }),
    diameter(['mm', 'in'], ['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M16']),
    length(['mm', 'in'], ['10', '16', '20', '25', '30', '40', '50', '60', '80', '100']),
    measure('thread_pitch', 'Thread pitch', ['mm', 'TPI']),
    choice('head_type', 'Head type', ['Hex', 'Socket cap', 'Countersunk', 'Pan', 'Button', 'Flange']),
    grade(['4.6', '8.8', '10.9', '12.9', 'A2-70', 'A4-80'], 'Material grade'),
    finish(['Plain', 'Zinc plated', 'Hot-dip galvanised', 'Black oxide', 'Stainless']),
    packCount(['10', '25', '50', '100', '500', '1000']),
    choice('drive_type', 'Drive', ['Hex', 'Torx', 'Phillips', 'Pozidriv', 'Slotted', 'Square']),
    choice('thread_type', 'Thread', ['Full thread', 'Part thread', 'Self tapping', 'Self drilling']),
  ]),

  template('industrial-supplies', 'bearings-power-transmission', 'Bearings & Power Transmission', [
    choice('component_type', 'Type', ['Deep groove ball', 'Tapered roller', 'Needle roller', 'Pillow block', 'Pulley', 'Chain', 'Coupling'], {
      importance: 'RECOMMENDED',
    }),
    measure('bore_diameter', 'Bore diameter', ['mm', 'in'], { importance: 'RECOMMENDED' }),
    measure('outer_diameter', 'Outer diameter', ['mm', 'in'], { importance: 'RECOMMENDED' }),
    measure('width', 'Width', ['mm', 'in']),
    choice('seal_type', 'Seal or shield', ['Open', '2RS (rubber sealed)', 'ZZ (metal shielded)', 'Single seal']),
    choice('series', 'Series', ['6000', '6200', '6300', '32000', '30000']),
    measure('load_rating', 'Dynamic load rating', ['kN', 'N']),
    measure('speed_rating', 'Speed rating', ['rpm']),
    choice('cage_material', 'Cage material', ['Steel', 'Brass', 'Polyamide']),
    choice('precision_class', 'Precision class', ['P0 / Normal', 'P6', 'P5', 'P4']),
  ]),

  template('industrial-supplies', 'hydraulics-pneumatics', 'Hydraulics & Pneumatics', [
    choice('component_type', 'Type', ['Cylinder', 'Valve', 'Fitting', 'Hose', 'Filter', 'Regulator'], {
      importance: 'RECOMMENDED',
    }),
    measure('port_size', 'Port size', ['mm', 'in', 'BSP', 'NPT'], { importance: 'RECOMMENDED' }),
    measure('bore', 'Bore', ['mm']),
    measure('stroke', 'Stroke', ['mm']),
    measure('pressure_rating', 'Pressure rating', ['bar', 'psi', 'MPa'], { importance: 'RECOMMENDED' }),
    measure('flow_rating', 'Flow rating', ['L/min', 'CFM']),
    material(['NBR', 'Viton (FKM)', 'EPDM', 'PTFE', 'Silicone']),
    choice('connection_type', 'Connection', ['Threaded', 'Push-in', 'Flanged', 'Quick release']),
    choice('acting_type', 'Action', ['Single acting', 'Double acting']),
    choice('mounting', 'Mounting', ['Foot mount', 'Flange mount', 'Clevis', 'Trunnion']),
  ]),

  template('industrial-supplies', 'pumps-valves', 'Pumps & Valves', [
    choice('pump_type', 'Type', ['Centrifugal pump', 'Diaphragm pump', 'Gear pump', 'Ball valve', 'Gate valve', 'Butterfly valve'], {
      importance: 'RECOMMENDED',
    }),
    measure('port_size', 'Inlet / outlet size', ['mm', 'in', 'DN'], { importance: 'RECOMMENDED' }),
    measure('flow_rate', 'Flow rate', ['L/min', 'm3/h', 'GPM']),
    measure('head', 'Head', ['m', 'ft']),
    measure('pressure_rating', 'Pressure rating', ['bar', 'psi', 'PN']),
    material(['Cast iron', 'Stainless steel 316', 'Stainless steel 304', 'Bronze', 'PVC', 'PP']),
    choice('actuation', 'Actuation', ['Manual', 'Electric', 'Pneumatic', 'Hydraulic']),
    voltage(),
    choice('phase', 'Phase', ['Single phase', 'Three phase'], { inTitle: false }),
    choice('mounting', 'Mounting', ['Monoblock', 'Coupled', 'Submersible', 'Inline']),
    choice('seal_type', 'Seal', ['Mechanical seal', 'Gland packing', 'Magnetic drive']),
  ]),

  template('industrial-supplies', 'abrasives', 'Abrasives', [
    choice('product_type', 'Type', ['Cutting disc', 'Grinding disc', 'Flap disc', 'Sanding sheet', 'Sanding belt', 'Wire brush'], {
      importance: 'RECOMMENDED',
    }),
    choice('grit', 'Grit', ['40', '60', '80', '100', '120', '180', '240', '320', '400'], {
      importance: 'RECOMMENDED',
    }),
    diameter(['mm', 'in'], ['100', '115', '125', '150', '180', '230']),
    measure('width', 'Width', ['mm', 'in']),
    measure('thickness', 'Thickness', ['mm'], { suggestions: ['1', '1.6', '2.5', '3', '6'] }),
    choice('backing', 'Backing', ['Paper', 'Cloth', 'Fibre', 'Film', 'Resin']),
    material(['Aluminium oxide', 'Silicon carbide', 'Zirconia', 'Ceramic', 'Diamond']),
    packCount(['1', '5', '10', '25', '50', '100']),
    choice('bore_size', 'Bore size', ['16 mm', '22.23 mm', '25.4 mm', '31.75 mm']),
    choice('bond_type', 'Bond', ['Resin', 'Vitrified', 'Rubber', 'Metal']),
  ]),

  template('industrial-supplies', 'lubricants-adhesives', 'Lubricants & Adhesives', [
    choice('chemistry', 'Chemistry or type', ['Mineral oil', 'Synthetic oil', 'Lithium grease', 'Cyanoacrylate', 'Epoxy', 'Silicone', 'PU'], {
      importance: 'RECOMMENDED',
    }),
    grade(['ISO VG 32', 'ISO VG 46', 'ISO VG 68', 'NLGI 2', 'SAE 10W-40'], 'Viscosity or grade'),
    choice('application', 'Application', ['General purpose', 'High temperature', 'Food grade', 'Structural', 'Thread locking']),
    measure('temperature_range', 'Temperature range', ['C']),
    choice('curing_type', 'Curing', ['Air cure', 'Heat cure', 'UV cure', 'Two part', 'Anaerobic']),
    netWeight(['50', '100', '400', '500', '1', '5', '20']),
    netVolume(['50', '250', '500', '1', '5', '20', '200']),
    choice('container_type', 'Container', ['Tube', 'Cartridge', 'Bottle', 'Tin', 'Pail', 'Drum']),
    choice('base_oil', 'Base', ['Mineral', 'Semi synthetic', 'Fully synthetic']),
    choice('colour_when_cured', 'Cured colour', ['Clear', 'White', 'Black', 'Grey', 'Amber']),
  ]),

  template('industrial-supplies', 'welding-soldering', 'Welding & Soldering', [
    choice('process', 'Process', ['MMA (stick)', 'MIG/MAG', 'TIG', 'Gas', 'Soldering', 'Brazing'], {
      importance: 'RECOMMENDED',
    }),
    choice('compatible_material', 'For material', ['Mild steel', 'Stainless steel', 'Aluminium', 'Cast iron', 'Copper']),
    diameter(['mm'], ['0.6', '0.8', '1.0', '1.2', '1.6', '2.0', '2.5', '3.2', '4.0']),
    netWeight(['0.8', '1', '5', '15'], 'Spool or pack weight'),
    measure('current_range', 'Current range', ['A']),
    choice('gas_or_flux', 'Gas or flux', ['CO2', 'Argon', 'Argon/CO2 mix', 'Rosin flux', 'No-clean flux', 'Gasless']),
    packCount(['1', '5', '10']),
    choice('polarity', 'Polarity', ['DC+', 'DC-', 'AC', 'AC/DC']),
    choice('coating_type', 'Coating', ['Rutile', 'Basic', 'Cellulosic', 'Copper coated']),
  ]),

  template('industrial-supplies', 'material-handling', 'Material Handling', [
    choice('equipment_type', 'Type', ['Pallet truck', 'Stacker', 'Trolley', 'Hoist', 'Conveyor', 'Drum handler'], {
      importance: 'RECOMMENDED',
    }),
    measure('load_capacity', 'Load capacity', ['kg', 't'], { importance: 'RECOMMENDED', suggestions: ['500', '1000', '1500', '2000', '2500', '3000'] }),
    measure('lift_height', 'Lift height', ['mm', 'm']),
    measure('fork_dimensions', 'Platform or fork size', ['mm']),
    material(['Nylon wheels', 'Polyurethane wheels', 'Rubber wheels', 'Cast iron wheels']),
    choice('power_source', 'Power source', ['Manual', 'Semi-electric', 'Electric', 'Battery']),
    voltage(),
    choice('fork_type', 'Fork or platform', ['Standard fork', 'Wide fork', 'Long fork', 'Flat platform']),
    choice('mast_type', 'Mast', ['Simplex', 'Duplex', 'Triplex', 'Not applicable']),
  ]),
];

// ---------------------------------------------------------------------------
// 3. TOOLS & HARDWARE
// ---------------------------------------------------------------------------

const TOOLS: readonly VariantTemplate[] = [
  template('tools-hardware', 'hand-tools', 'Hand Tools', [
    choice('tool_type', 'Tool type', ['Spanner', 'Socket', 'Screwdriver', 'Plier', 'Hammer', 'Chisel', 'File'], {
      importance: 'RECOMMENDED',
    }),
    measure('drive_size', 'Drive, jaw or blade size', ['mm', 'in'], { importance: 'RECOMMENDED' }),
    length(['mm', 'cm', 'in']),
    material(['Chrome vanadium', 'Carbon steel', 'Stainless steel', 'Forged steel']),
    finish(['Chrome plated', 'Black phosphate', 'Polished', 'Powder coated']),
    choice('handle_type', 'Handle', ['Bi-material', 'Rubber', 'Wooden', 'Insulated (VDE)', 'Bare']),
    pieceCount(['1', '6', '8', '12', '24', '40'], 'Pieces in set'),
    choice('drive_type', 'Drive', ['1/4 inch', '3/8 inch', '1/2 inch', '3/4 inch']),
    flag('insulated', 'Insulated', ['VDE insulated', 'Not insulated']),
  ]),

  template('tools-hardware', 'power-tools', 'Power Tools', [
    choice('tool_type', 'Tool type', ['Drill', 'Impact driver', 'Angle grinder', 'Circular saw', 'Jigsaw', 'Sander', 'Rotary hammer'], {
      importance: 'RECOMMENDED',
    }),
    voltage(['12 V', '18 V', '20 V', '36 V', '110 V', '220-240 V']),
    measure('power', 'Power', ['W', 'kW'], { suggestions: ['500', '750', '900', '1200', '1500', '2000'] }),
    measure('chuck_size', 'Chuck, disc or blade size', ['mm', 'in'], { suggestions: ['10', '13', '115', '125', '165', '185'] }),
    measure('speed', 'Speed', ['rpm']),
    measure('battery_capacity', 'Battery capacity', ['Ah'], { suggestions: ['2', '4', '5', '6'] }),
    choice('power_mode', 'Corded or cordless', ['Corded', 'Cordless (bare tool)', 'Cordless with battery'], {
      importance: 'RECOMMENDED',
    }),
    choice('kit_contents', 'Kit contents', ['Tool only', 'With charger', 'With case', 'Full kit']),
    choice('battery_platform', 'Battery platform', ['Bare tool', 'One battery', 'Two batteries']),
    flag('brushless', 'Motor', ['Brushless', 'Brushed']),
  ]),

  template('tools-hardware', 'cutting-tools', 'Cutting Tools', [
    choice('cutter_type', 'Type', ['Twist drill', 'End mill', 'Tap', 'Die', 'Hole saw', 'Saw blade', 'Reamer'], {
      importance: 'RECOMMENDED',
    }),
    diameter(['mm', 'in'], ['3', '4', '5', '6', '8', '10', '12', '16', '20']),
    measure('cutting_length', 'Cutting length', ['mm']),
    choice('flute_count', 'Teeth or flutes', ['2', '3', '4', '6', '24', '40', '60', '80']),
    material(['HSS', 'HSS-Co', 'Carbide', 'Diamond tipped', 'TCT']),
    finish(['Uncoated', 'TiN', 'TiAlN', 'Black oxide']),
    measure('shank_size', 'Shank size', ['mm', 'in']),
    packCount(['1', '5', '10', '19', '25']),
    choice('shank_type', 'Shank type', ['Straight', 'Hex', 'SDS-plus', 'SDS-max', 'Morse taper']),
    choice('point_angle', 'Point angle', ['118 deg', '135 deg', '140 deg']),
  ]),

  template('tools-hardware', 'measuring-layout', 'Measuring & Layout', [
    choice('instrument_type', 'Type', ['Tape measure', 'Vernier caliper', 'Micrometer', 'Spirit level', 'Square', 'Laser level'], {
      importance: 'RECOMMENDED',
    }),
    measure('range', 'Range or length', ['mm', 'm', 'ft'], { importance: 'RECOMMENDED', suggestions: ['150', '200', '300', '3', '5', '8', '10'] }),
    measure('accuracy', 'Accuracy', ['mm', 'um']),
    choice('unit_system', 'Unit system', ['Metric', 'Imperial', 'Metric and imperial'], { allowsCustomValues: false }),
    material(['Stainless steel', 'Aluminium', 'ABS', 'Fibreglass']),
    choice('readout', 'Laser or manual', ['Manual', 'Digital', 'Laser']),
    choice('kit_contents', 'Kit contents', ['Instrument only', 'With case', 'With tripod']),
    choice('resolution', 'Resolution', ['0.01 mm', '0.02 mm', '0.05 mm', '1 mm']),
    choice('power_source', 'Power source', ['Manual', 'Battery', 'Rechargeable']),
  ]),

  template('tools-hardware', 'tool-storage', 'Tool Storage', [
    choice('storage_type', 'Type', ['Tool box', 'Tool chest', 'Roller cabinet', 'Tool bag', 'Organiser case'], {
      importance: 'RECOMMENDED',
    }),
    measure('external_dimensions', 'External dimensions', ['mm', 'cm'], { importance: 'RECOMMENDED' }),
    capacity(['L', 'kg']),
    choice('drawer_count', 'Drawers or trays', ['1', '2', '3', '5', '7', '9']),
    material(['Steel', 'Aluminium', 'Polypropylene', 'Canvas']),
    colour(['Black', 'Red', 'Blue', 'Grey', 'Yellow']),
    flag('locking', 'Locking', ['Lockable', 'Not lockable']),
    flag('wheels', 'Wheels', ['On wheels', 'No wheels']),
    choice('compartments', 'Compartments', ['1', '2', '3', '5', '7', '12', '24']),
    flag('tool_included', 'Tools included', ['Empty', 'With tools']),
  ]),
];

// ---------------------------------------------------------------------------
// 4. ELECTRICAL & LIGHTING
// ---------------------------------------------------------------------------

const ELECTRICAL: readonly VariantTemplate[] = [
  template('electrical-lighting', 'cables-wiring', 'Cables & Wiring', [
    choice('cable_type', 'Cable type', ['Single core', 'Multicore flexible', 'Armoured (SWA)', 'Coaxial', 'Data (Cat 6)', 'Welding cable'], {
      importance: 'RECOMMENDED',
    }),
    material(['Copper', 'Tinned copper', 'Aluminium']),
    choice('cores', 'Number of cores', ['1', '2', '3', '4', '5'], { importance: 'RECOMMENDED' }),
    measure('cross_section', 'Cross-sectional area', ['mm2', 'AWG'], {
      importance: 'RECOMMENDED',
      suggestions: ['0.75', '1', '1.5', '2.5', '4', '6', '10', '16'],
    }),
    measure('voltage_rating', 'Voltage rating', ['V'], { suggestions: ['300/500', '450/750', '600/1000'] }),
    choice('insulation', 'Insulation', ['PVC', 'XLPE', 'LSZH', 'Rubber', 'Silicone']),
    colour(['Black', 'Red', 'Blue', 'Yellow/Green', 'Brown', 'Grey', 'White']),
    length(['m'], ['10', '25', '50', '100', '500', '1000']),
    choice('armour', 'Armour', ['Unarmoured', 'Steel wire armoured', 'Steel tape armoured']),
    choice('flexibility', 'Flexibility', ['Solid conductor', 'Stranded', 'Highly flexible']),
  ]),

  template('electrical-lighting', 'switches-sockets', 'Switches & Sockets', [
    choice('device_type', 'Device type', ['Switch', 'Socket outlet', 'Dimmer', 'Fan regulator', 'Blank plate', 'USB outlet'], {
      importance: 'RECOMMENDED',
    }),
    choice('module_size', 'Module size', ['1 module', '2 module', '3 module', '4 module', '6 module', '8 module']),
    measure('current_rating', 'Current rating', ['A'], { importance: 'RECOMMENDED', suggestions: ['6', '10', '13', '16', '20', '32'] }),
    measure('voltage_rating', 'Voltage', ['V'], { suggestions: ['230', '240', '110'] }),
    choice('ways', 'Poles or ways', ['1 way', '2 way', 'Intermediate', 'Double pole']),
    finish(['Glossy white', 'Matt white', 'Brushed steel', 'Black', 'Ivory']),
    colour(['White', 'Black', 'Grey', 'Ivory', 'Steel']),
    packCount(['1', '5', '10', '20']),
    choice('plate_type', 'Plate', ['With plate', 'Module only', 'Plate only']),
    flag('indicator', 'Indicator', ['With indicator', 'Without indicator']),
  ]),

  template('electrical-lighting', 'circuit-protection', 'Circuit Protection', [
    choice('device_type', 'Device type', ['MCB', 'RCCB', 'RCBO', 'MCCB', 'Isolator', 'Surge protector', 'Fuse'], {
      importance: 'RECOMMENDED',
    }),
    choice('poles', 'Poles', ['1P', '1P+N', '2P', '3P', '3P+N', '4P'], { importance: 'RECOMMENDED' }),
    measure('current_rating', 'Current rating', ['A'], { importance: 'RECOMMENDED', suggestions: ['6', '10', '16', '20', '25', '32', '40', '63'] }),
    measure('voltage_rating', 'Voltage', ['V']),
    measure('breaking_capacity', 'Breaking capacity', ['kA'], { suggestions: ['4.5', '6', '10'] }),
    choice('trip_curve', 'Trip curve', ['B', 'C', 'D'], { allowsCustomValues: false }),
    measure('sensitivity', 'Sensitivity', ['mA'], { suggestions: ['30', '100', '300'] }),
    choice('mounting', 'Mounting', ['DIN rail', 'Panel mount', 'Plug-in']),
  ]),

  template('electrical-lighting', 'motors-drives', 'Motors & Drives', [
    choice('motor_type', 'Type', ['Induction motor', 'Servo motor', 'Stepper motor', 'VFD', 'Soft starter', 'Gear motor'], {
      importance: 'RECOMMENDED',
    }),
    measure('output_power', 'Output power', ['kW', 'HP'], { importance: 'RECOMMENDED', suggestions: ['0.37', '0.75', '1.5', '2.2', '3.7', '5.5', '7.5'] }),
    voltage(['230 V', '415 V', '440 V']),
    choice('phase', 'Phase', ['Single phase', 'Three phase'], { importance: 'RECOMMENDED' }),
    measure('speed', 'Speed', ['rpm'], { suggestions: ['960', '1440', '2880'] }),
    choice('frame_size', 'Frame size', ['63', '71', '80', '90', '100', '112', '132']),
    choice('enclosure', 'Enclosure', ['TEFC', 'ODP', 'Flameproof']),
    choice('ip_rating', 'IP rating', ['IP20', 'IP44', 'IP55', 'IP65']),
    choice('mounting', 'Mounting', ['Foot mounted', 'Flange mounted', 'Face mounted']),
    choice('efficiency_class', 'Efficiency class', ['IE1', 'IE2', 'IE3', 'IE4']),
  ]),

  template('electrical-lighting', 'lighting', 'Lighting', [
    choice('fixture_type', 'Fixture or bulb type', ['LED bulb', 'LED panel', 'Tube light', 'Flood light', 'Street light', 'Downlight', 'Batten'], {
      importance: 'RECOMMENDED',
    }),
    measure('wattage', 'Wattage', ['W'], { importance: 'RECOMMENDED', suggestions: ['5', '9', '12', '18', '20', '36', '50', '100', '200'] }),
    measure('lumens', 'Lumens', ['lm']),
    choice('colour_temperature', 'Colour temperature', ['2700K Warm white', '4000K Cool white', '6500K Daylight'], {
      importance: 'RECOMMENDED',
    }),
    colour(['White', 'Warm white', 'Daylight', 'RGB', 'Amber']),
    choice('base_type', 'Base or cap', ['B22', 'E27', 'E14', 'GU10', 'G13', 'G9']),
    measure('size', 'Size', ['mm', 'ft'], { suggestions: ['2', '4', '600', '1200'] }),
    measure('beam_angle', 'Beam angle', ['deg'], { suggestions: ['15', '38', '60', '120'] }),
    flag('dimmable', 'Dimmable', ['Dimmable', 'Not dimmable']),
    packCount(['1', '2', '4', '10', '20']),
    choice('ip_rating', 'IP rating', ['IP20', 'IP44', 'IP65', 'IP66', 'IP67'], { allowsCustomValues: false }),
    choice('mounting', 'Mounting', ['Surface', 'Recessed', 'Suspended', 'Pole', 'Track']),
    choice('driver', 'Driver', ['Integrated driver', 'External driver', 'No driver']),
  ]),

  template('electrical-lighting', 'batteries-power-supplies', 'Batteries & Power Supplies', [
    choice('battery_type', 'Type', ['Dry cell', 'Rechargeable cell', 'Lead acid', 'Li-ion pack', 'SMPS', 'Inverter'], {
      importance: 'RECOMMENDED',
    }),
    choice('chemistry', 'Chemistry', ['Alkaline', 'NiMH', 'Li-ion', 'LiFePO4', 'Lead acid', 'Zinc carbon']),
    measure('voltage_rating', 'Voltage', ['V'], { importance: 'RECOMMENDED', suggestions: ['1.5', '3.7', '9', '12', '24', '48'] }),
    measure('battery_capacity', 'Capacity', ['Ah', 'mAh'], { importance: 'RECOMMENDED', suggestions: ['1000', '2000', '2600', '7', '100', '150'] }),
    choice('form_factor', 'Form factor', ['AA', 'AAA', 'C', 'D', '9V', '18650', 'Tall tubular']),
    choice('terminal_type', 'Terminal', ['Flat top', 'Button top', 'Screw', 'Bolt', 'Spade']),
    measure('output_rating', 'Output rating', ['W', 'A', 'VA']),
    packCount(['1', '2', '4', '6', '10', '20']),
    flag('rechargeable', 'Rechargeable', ['Rechargeable', 'Single use']),
    choice('warranty', 'Warranty', ['1 year', '2 years', '3 years', '5 years'], { inTitle: false }),
  ]),
];

// ---------------------------------------------------------------------------
// 5. ELECTRONICS & COMPONENTS
// ---------------------------------------------------------------------------

const ELECTRONICS: readonly VariantTemplate[] = [
  template('electronics-components', 'electronic-components', 'Electronic Components', [
    choice('component_type', 'Component type', ['Resistor', 'Capacitor', 'Inductor', 'Diode', 'Transistor', 'IC', 'Crystal'], {
      importance: 'RECOMMENDED',
    }),
    measure('value', 'Value', ['ohm', 'kohm', 'Mohm', 'pF', 'nF', 'uF', 'uH', 'mH'], { importance: 'RECOMMENDED' }),
    measure('tolerance', 'Tolerance', ['%'], { suggestions: ['1', '2', '5', '10', '20'] }),
    choice('package', 'Package or footprint', ['0402', '0603', '0805', '1206', 'DIP-8', 'SOIC-8', 'TO-220', 'SOT-23']),
    measure('voltage_rating', 'Voltage rating', ['V'], { suggestions: ['6.3', '16', '25', '50', '100', '400'] }),
    measure('current_rating', 'Current rating', ['A', 'mA']),
    choice('temperature_grade', 'Temperature grade', ['Commercial (0-70C)', 'Industrial (-40-85C)', 'Automotive (-40-125C)']),
    packCount(['10', '50', '100', '500', '1000', '5000']),
    choice('mounting', 'Mounting', ['Through hole', 'Surface mount']),
    measure('power_rating', 'Power rating', ['W', 'mW'], { suggestions: ['0.125', '0.25', '0.5', '1', '2'] }),
  ]),

  template('electronics-components', 'sensors-automation', 'Sensors & Automation', [
    choice('device_type', 'Device type', ['Proximity sensor', 'Photoelectric sensor', 'Temperature sensor', 'Pressure sensor', 'PLC', 'HMI', 'Encoder'], {
      importance: 'RECOMMENDED',
    }),
    measure('sensing_range', 'Sensing range', ['mm', 'm', 'C', 'bar'], { importance: 'RECOMMENDED' }),
    choice('output_type', 'Output type', ['NPN', 'PNP', 'Analogue 4-20 mA', 'Analogue 0-10 V', 'Relay', 'Digital']),
    choice('protocol', 'Communication protocol', ['Modbus RTU', 'Modbus TCP', 'Profinet', 'EtherCAT', 'IO-Link', 'CANopen']),
    measure('supply_voltage', 'Supply voltage', ['V DC', 'V AC'], { suggestions: ['5', '12', '24', '230'] }),
    measure('accuracy', 'Accuracy', ['%', 'mm', 'C']),
    choice('enclosure', 'Enclosure', ['Plastic', 'Stainless steel', 'Nickel-plated brass']),
    choice('ip_rating', 'IP rating', ['IP54', 'IP65', 'IP67', 'IP68']),
    choice('connection', 'Connection', ['Cable', 'M8 connector', 'M12 connector', 'Terminal']),
    choice('mounting', 'Mounting', ['Flush', 'Non-flush', 'DIN rail', 'Panel']),
  ]),

  template('electronics-components', 'test-measurement', 'Test & Measurement', [
    choice('device_type', 'Device type', ['Multimeter', 'Oscilloscope', 'Power supply', 'Function generator', 'Clamp meter', 'LCR meter'], {
      importance: 'RECOMMENDED',
    }),
    choice('channels', 'Channels', ['1', '2', '4', '8'], { importance: 'RECOMMENDED' }),
    measure('measurement_range', 'Measurement range', ['V', 'A', 'ohm', 'Hz']),
    measure('accuracy', 'Accuracy', ['%']),
    measure('bandwidth', 'Bandwidth', ['MHz', 'GHz'], { suggestions: ['50', '70', '100', '200'] }),
    choice('safety_category', 'Measurement category', ['CAT II', 'CAT III', 'CAT IV']),
    choice('probe_configuration', 'Probes supplied', ['No probes', 'Standard probes', 'High-voltage probes']),
    choice('kit_contents', 'Kit contents', ['Instrument only', 'With case', 'With calibration certificate']),
    choice('display', 'Display', ['LCD', 'Backlit LCD', 'TFT', 'Analogue']),
    choice('power_source', 'Power source', ['Battery', 'Mains', 'Rechargeable', 'USB']),
  ]),

  template('electronics-components', 'enclosures-connectors', 'Enclosures & Connectors', [
    choice('component_type', 'Type', ['Enclosure', 'Junction box', 'Circular connector', 'Terminal block', 'Header', 'Cable gland'], {
      importance: 'RECOMMENDED',
    }),
    measure('enclosure_size', 'Enclosure size', ['mm'], { importance: 'RECOMMENDED' }),
    choice('pin_count', 'Pin count', ['2', '3', '4', '6', '8', '10', '16', '24']),
    material(['ABS', 'Polycarbonate', 'Steel', 'Stainless steel', 'Aluminium', 'Brass']),
    choice('ip_rating', 'IP rating', ['IP44', 'IP54', 'IP65', 'IP66', 'IP67']),
    choice('mounting', 'Mounting', ['Wall mount', 'DIN rail', 'Panel mount', 'PCB mount']),
    choice('termination', 'Termination', ['Screw', 'Spring cage', 'Crimp', 'Solder', 'IDC']),
    colour(['Grey', 'Black', 'White', 'Transparent']),
    packCount(['1', '5', '10', '50', '100']),
    choice('gender', 'Gender', ['Male', 'Female', 'Hermaphroditic']),
    choice('knockouts', 'Knockouts', ['Plain', 'Pre-punched']),
  ]),
];

export const INDUSTRIAL_TEMPLATES: readonly VariantTemplate[] = Object.freeze([
  ...LABORATORY,
  ...INDUSTRIAL,
  ...TOOLS,
  ...ELECTRICAL,
  ...ELECTRONICS,
]);
