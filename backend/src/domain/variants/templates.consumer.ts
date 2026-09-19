/**
 * Variant templates: the last seven departments.
 *
 * Clothing & Textiles, Beauty & Personal Care, Sports & Outdoors,
 * Toys Hobbies & Crafts, Books & Media, Chemicals & Raw Materials,
 * Energy & Environment.
 *
 * Clothing and footwear are the two shelves where getting this wrong is most
 * visible to a buyer, so two things are deliberate here.
 *
 * SIZE AND SIZE SYSTEM ARE SEPARATE AXES. An 8 is a different shoe in UK, EU
 * and US, and a catalogue that prints a bare number is asking somebody to
 * guess. The size axis declares the system axis as a dependency, so the
 * selector cannot offer the number until the system is settled.
 *
 * NO SIZE CHART IS ASSUMED. The suggestions are a starting run, not a claim
 * about what this brand's L measures. The chest and body measurements shown on
 * the product page are the seller's own, stored against the product; where the
 * seller has given none, none is shown. Two brands' size L differ by several
 * centimetres and inventing the difference is how a buyer is sent the wrong
 * shirt.
 */
import { template, type VariantTemplate } from './axis.js';
import {
  ageGroup,
  apparelSize,
  capacity,
  choice,
  closure,
  colour,
  diameter,
  finish,
  fit,
  flag,
  grade,
  length,
  material,
  measure,
  netVolume,
  netWeight,
  numericSize,
  packCount,
  pattern,
  pieceCount,
  sizeSystem,
  style,
  voltage,
  width,
} from './library.js';

// ---------------------------------------------------------------------------
// 18. CLOTHING & TEXTILES
// ---------------------------------------------------------------------------

const CLOTHING: readonly VariantTemplate[] = [
  template('clothing-textiles', 'workwear-uniforms', 'Workwear & Uniforms', [
    choice('garment_type', 'Garment', ['Shirt', 'Trouser', 'Coverall', 'Boiler suit', 'Jacket', 'Apron', 'Scrub set', 'Dungaree', 'Waistcoat'], {
      importance: 'RECOMMENDED',
    }),
    apparelSize(['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL']),
    choice('chest_size', 'Chest size', ['34', '36', '38', '40', '42', '44', '46', '48'], {
      display: 'CHIPS',
    }),
    fit(['Unisex', 'Mens', 'Womens', 'Regular fit', 'Slim fit', 'Relaxed fit'], 'Gender or fit'),
    colour(['Navy', 'Grey', 'White', 'Black', 'Royal blue', 'Bottle green', 'Khaki', 'Orange'], 'RECOMMENDED'),
    material(['100% cotton', 'Polyester cotton 65/35', 'Polyester cotton 80/20', 'Polyester', 'Twill', 'Drill', 'Canvas', 'Denim']),
    measure('gsm', 'GSM', ['gsm'], { suggestions: ['140', '160', '180', '200', '240', '280'] }),
    choice('sleeve_length', 'Sleeve', ['Half sleeve', 'Full sleeve', 'Sleeveless', 'Roll-up sleeve'], {
      allowsCustomValues: false,
    }),
    closure(['Button', 'Zip', 'Press stud', 'Velcro', 'Pull on']),
    style(['Plain', 'With pockets', 'Reflective tape', 'Logo ready', 'Two tone']),
  ]),

  template('clothing-textiles', 'everyday-clothing', 'Everyday Clothing', [
    choice('product_type', 'Type', ['T-shirt', 'Shirt', 'Trouser', 'Jeans', 'Dress', 'Hoodie', 'Sweatshirt', 'Kurta', 'Shorts', 'Track pant'], {
      importance: 'RECOMMENDED',
    }),
    // The letter run and the numeric run are two different size systems, and
    // a formal shirt is sold on the second. They cannot share a key.
    apparelSize(['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL']),
    choice('chest_size', 'Shirt size', ['34', '36', '38', '39', '40', '42', '44', '46', '48']),
    colour(['Black', 'White', 'Navy', 'Grey', 'Olive', 'Maroon', 'Beige', 'Sky blue', 'Mustard'], 'RECOMMENDED'),
    fit(['Regular', 'Slim', 'Relaxed', 'Oversized', 'Boxy', 'Straight']),
    material(['100% cotton', 'Cotton blend', 'Polyester', 'Linen', 'Denim', 'Rayon', 'Modal', 'Viscose', 'Lycra blend']),
    pattern(['Solid', 'Striped', 'Checked', 'Printed', 'Colourblock', 'Graphic print', 'Self design']),
    style(['Round neck', 'V-neck', 'Polo', 'Collared', 'Henley', 'Hooded', 'Mandarin collar'], 'Neckline'),
    choice('sleeve_length', 'Sleeve', ['Sleeveless', 'Short sleeve', 'Three-quarter sleeve', 'Full sleeve']),
  ]),

  template('clothing-textiles', 'footwear', 'Footwear', [
    sizeSystem(['UK/India', 'EU', 'US']),
    numericSize(['5', '6', '7', '8', '9', '10', '11', '12', '13']),
    choice('width', 'Width fitting', ['Narrow', 'Standard', 'Wide', 'Extra wide']),
    fit(['Mens', 'Womens', 'Unisex', 'Kids'], 'Gender or fit'),
    colour(['Black', 'Brown', 'White', 'Tan', 'Navy', 'Grey', 'Olive'], 'RECOMMENDED'),
    material(['Leather', 'Synthetic leather', 'Nubuck', 'Suede', 'Canvas', 'Mesh', 'Knitted fabric']),
    choice('sole_material', 'Sole', ['Rubber', 'EVA', 'PU', 'TPR', 'Phylon', 'Leather']),
    choice('ankle_height', 'Ankle height', ['Low ankle', 'Mid ankle', 'High ankle']),
    closure(['Lace-up', 'Slip-on', 'Velcro', 'Buckle', 'Zip']),
  ]),

  template('clothing-textiles', 'fabrics-trims', 'Fabrics & Trims', [
    choice('fabric_type', 'Type', ['Woven fabric', 'Knit fabric', 'Lining', 'Interlining', 'Zip', 'Button', 'Elastic tape', 'Thread', 'Lace'], {
      importance: 'RECOMMENDED',
    }),
    material(['100% cotton', 'Polyester', 'Viscose', 'Cotton lycra', 'Nylon', 'Silk', 'Linen', 'Rayon', 'Poly cotton']),
    colour(['White', 'Black', 'Navy', 'Beige', 'Red', 'Dyed to order'], 'RECOMMENDED'),
    pattern(['Solid', 'Printed', 'Yarn dyed', 'Jacquard', 'Dobby', 'Embroidered']),
    width(['cm', 'in'], ['44', '58', '60', '108', '150']),
    measure('gsm', 'GSM or weight', ['gsm', 'oz'], { suggestions: ['120', '160', '180', '240', '320'] }),
    length(['m', 'yd'], ['1', '5', '10', '25', '50', '100']),
    finish(['Mill finish', 'Mercerised', 'Bio-washed', 'Sanforised', 'Water repellent']),
    choice('roll_configuration', 'Supplied as', ['Cut length', 'Full roll', 'Thaan'], {
      allowsCustomValues: false,
    }),
  ]),
];

// ---------------------------------------------------------------------------
// 19. BEAUTY & PERSONAL CARE
// ---------------------------------------------------------------------------

const BEAUTY: readonly VariantTemplate[] = [
  template('beauty-personal-care', 'skin-hair-care', 'Skin & Hair Care', [
    choice('product_type', 'Type', ['Shampoo', 'Conditioner', 'Face wash', 'Moisturiser', 'Serum', 'Hair oil'], {
      importance: 'RECOMMENDED',
    }),
    choice('formulation', 'Formulation or variant', ['Cream', 'Gel', 'Lotion', 'Oil', 'Foam', 'Bar']),
    netVolume(['50', '100', '200', '250', '400', '1'], 'Pack volume'),
    netWeight(['50', '100', '200', '500'], 'Pack weight'),
    choice('suitability', 'Skin or hair type', ['All types', 'Dry', 'Oily', 'Combination', 'Sensitive', 'Coloured hair']),
    choice('fragrance', 'Fragrance', ['Unscented', 'Floral', 'Citrus', 'Herbal', 'Woody']),
    packCount(['1', '2', '3', '6', '12']),
    choice('concern', 'Concern', ['Dryness', 'Dandruff', 'Hair fall', 'Acne', 'Ageing', 'Pigmentation']),
    flag('paraben_free', 'Formulation', ['Paraben free', 'Standard']),
  ]),

  template('beauty-personal-care', 'cosmetics', 'Cosmetics', [
    choice('product_type', 'Type', ['Lipstick', 'Foundation', 'Compact', 'Kajal', 'Nail polish', 'Mascara'], {
      importance: 'RECOMMENDED',
    }),
    colour(['Nude', 'Red', 'Pink', 'Berry', 'Brown', 'Black'], 'RECOMMENDED'),
    finish(['Matt', 'Satin', 'Glossy', 'Shimmer', 'Metallic']),
    netWeight(['3', '4', '8', '12', '30'], 'Net weight'),
    netVolume(['5', '10', '15', '30'], 'Net volume'),
    choice('coverage', 'Coverage', ['Sheer', 'Medium', 'Full']),
    packCount(['1', '2', '3', '6']),
    choice('undertone', 'Undertone', ['Cool', 'Neutral', 'Warm']),
    flag('waterproof', 'Waterproof', ['Waterproof', 'Standard']),
  ]),

  template('beauty-personal-care', 'personal-hygiene', 'Personal Hygiene', [
    choice('product_type', 'Type', ['Sanitary pad', 'Adult diaper', 'Baby diaper', 'Wet wipe', 'Toothbrush', 'Deodorant'], {
      importance: 'RECOMMENDED',
    }),
    choice('size', 'Size', ['Small', 'Medium', 'Large', 'XL', 'Regular', 'XXL'], {
      importance: 'RECOMMENDED',
    }),
    choice('absorbency', 'Absorbency', ['Light', 'Regular', 'Heavy', 'Overnight']),
    choice('fragrance', 'Fragrance', ['Unscented', 'Lightly scented', 'Fresh']),
    measure('unit_count', 'Volume or count', ['ml', 'pieces'], { suggestions: ['10', '20', '30', '50', '150'] }),
    choice('suitability', 'Suitability', ['Adult', 'Child', 'Infant', 'Unisex'], { inTitle: false }),
    packCount(['1', '2', '3', '6', '12']),
    choice('form', 'Form', ['Pad', 'Tampon', 'Cup', 'Liner', 'Wipe']),
    flag('fragranced', 'Fragrance', ['Fragranced', 'Fragrance free']),
  ]),

  template('beauty-personal-care', 'salon-spa-supplies', 'Salon & Spa Supplies', [
    choice('product_type', 'Type', ['Hair colour', 'Bleach', 'Wax', 'Massage oil', 'Salon towel', 'Trimmer'], {
      importance: 'RECOMMENDED',
    }),
    capacity(['ml', 'g', 'L'], ['100', '250', '500', '1000']),
    material(['Cream', 'Powder', 'Resin', 'Cotton', 'Stainless steel']),
    colour(['Natural black', 'Burgundy', 'Blonde', 'White', 'Assorted']),
    choice('fragrance', 'Fragrance', ['Unscented', 'Lavender', 'Rose', 'Tea tree']),
    packCount(['1', '6', '12', '24', '50']),
    choice('application', 'Application', ['Hair', 'Skin', 'Nails', 'Body']),
    flag('professional_only', 'Intended for', ['Professional use', 'Retail']),
  ]),
];

// ---------------------------------------------------------------------------
// 20. SPORTS & OUTDOORS
// ---------------------------------------------------------------------------

const SPORTS: readonly VariantTemplate[] = [
  template('sports-outdoors', 'fitness-equipment', 'Fitness Equipment', [
    choice('equipment_type', 'Type', ['Dumbbell', 'Barbell plate', 'Resistance band', 'Treadmill', 'Exercise bike', 'Yoga mat'], {
      importance: 'RECOMMENDED',
    }),
    measure('resistance', 'Weight or resistance', ['kg', 'lb'], {
      importance: 'RECOMMENDED',
      suggestions: ['1', '2', '5', '7.5', '10', '15', '20'],
    }),
    measure('dimensions', 'Dimensions', ['mm', 'cm']),
    measure('weight_capacity', 'User weight capacity', ['kg'], { suggestions: ['100', '110', '120', '150'] }),
    colour(['Black', 'Grey', 'Blue', 'Purple', 'Red']),
    pieceCount(['1', '2', '4', '6'], 'Supplied as'),
    material(['Cast iron', 'Rubber coated', 'Neoprene', 'Vinyl', 'Steel']),
    flag('adjustable', 'Adjustable', ['Adjustable', 'Fixed weight']),
  ]),

  template('sports-outdoors', 'team-sports', 'Team Sports', [
    choice('item_type', 'Sport or item', ['Cricket bat', 'Football', 'Badminton racket', 'Shuttlecock', 'Basketball', 'Hockey stick'], {
      importance: 'RECOMMENDED',
    }),
    choice('standard_size', 'Size', ['Size 3', 'Size 4', 'Size 5', 'Junior', 'Senior', 'Full size'], {
      importance: 'RECOMMENDED',
    }),
    measure('weight', 'Weight', ['g', 'kg'], { suggestions: ['85', '156', '400', '450'] }),
    material(['Leather', 'Rubber', 'Synthetic', 'Willow', 'Carbon fibre', 'Aluminium']),
    colour(['White', 'Red', 'Blue', 'Yellow', 'Multicolour']),
    grade(['Beginner', 'Intermediate', 'Professional', 'Match'], 'Skill level'),
    packCount(['1', '3', '6', '12']),
    ageGroup(['Under 12', 'Youth', 'Adult']),
    flag('indoor_outdoor', 'Surface', ['Indoor', 'Outdoor']),
  ]),

  template('sports-outdoors', 'camping-outdoor', 'Camping & Outdoor', [
    choice('product_type', 'Type', ['Tent', 'Sleeping bag', 'Rucksack', 'Camping stove', 'Head torch', 'Cooler box'], {
      importance: 'RECOMMENDED',
    }),
    choice('person_capacity', 'Capacity', ['1 person', '2 person', '4 person', '6 person', '8 person'], {
      importance: 'RECOMMENDED',
    }),
    measure('dimensions', 'Dimensions', ['cm', 'mm', 'L'], { suggestions: ['30', '45', '60', '70'] }),
    material(['Polyester', 'Nylon', 'Ripstop', 'Canvas', 'Aluminium']),
    choice('season_rating', 'Season or temperature rating', ['2 season', '3 season', '4 season', '0C', '-5C', '-10C']),
    colour(['Green', 'Blue', 'Orange', 'Grey', 'Camouflage']),
    choice('kit_configuration', 'Kit configuration', ['Item only', 'With footprint', 'Complete kit']),
    flag('waterproof', 'Waterproof', ['Waterproof', 'Water resistant']),
    choice('setup', 'Setup', ['Instant', 'Pole and sleeve', 'Freestanding', 'Tunnel']),
  ]),

  template('sports-outdoors', 'cycling', 'Cycling', [
    choice('product_type', 'Type', ['Mountain bike', 'Road bike', 'Hybrid bike', 'Helmet', 'Tyre', 'Chain'], {
      importance: 'RECOMMENDED',
    }),
    choice('frame_size', 'Frame size', ['XS', 'S', 'M', 'L', 'XL', '16 in', '18 in', '20 in'], {
      importance: 'RECOMMENDED',
    }),
    diameter(['in'], ['20', '24', '26', '27.5', '29', '700c']),
    choice('gear_count', 'Gears', ['Single speed', '7 speed', '18 speed', '21 speed', '24 speed']),
    choice('brake_type', 'Brakes', ['V-brake', 'Disc brake', 'Hydraulic disc', 'Caliper']),
    colour(['Black', 'Red', 'Blue', 'White', 'Green'], 'RECOMMENDED'),
    choice('compatibility', 'Compatibility', []),
    choice('suspension', 'Suspension', ['Rigid', 'Front suspension', 'Full suspension']),
    choice('assembly', 'Supplied as', ['Fully assembled', '85% assembled', 'Flat packed']),
  ]),
];

// ---------------------------------------------------------------------------
// 21. TOYS, HOBBIES & CRAFTS
// ---------------------------------------------------------------------------

const TOYS: readonly VariantTemplate[] = [
  template('toys-hobbies-crafts', 'toys-games', 'Toys & Games', [
    choice('toy_type', 'Type', ['Building blocks', 'Board game', 'Puzzle', 'Soft toy', 'Ride-on', 'Remote control'], {
      importance: 'RECOMMENDED',
    }),
    choice('age_group', 'Age group', ['0-2 years', '3-5 years', '6-8 years', '9-12 years', '12+ years'], {
      importance: 'RECOMMENDED',
    }),
    choice('version', 'Version or theme', []),
    measure('dimensions', 'Dimensions', ['cm', 'mm']),
    colour(['Multicolour', 'Red', 'Blue', 'Pink', 'Assorted']),
    choice('player_count', 'Players', ['1', '2', '2-4', '2-6', '4+']),
    pieceCount(['1', '50', '100', '250', '500', '1000'], 'Pieces'),
    material(['ABS plastic', 'Wood', 'Plush fabric', 'Cardboard', 'Die-cast metal']),
    flag('battery_required', 'Batteries', ['Batteries required', 'No batteries needed']),
  ]),

  template('toys-hobbies-crafts', 'craft-materials', 'Craft Materials', [
    choice('material_type', 'Type', ['Acrylic paint', 'Craft paper', 'Yarn', 'Beads', 'Glue', 'Canvas'], {
      importance: 'RECOMMENDED',
    }),
    colour(['Assorted', 'White', 'Black', 'Red', 'Gold'], 'RECOMMENDED'),
    measure('size', 'Size', ['cm', 'mm', 'in'], { suggestions: ['A4', '20x30', '30x40'] }),
    netWeight(['50', '100', '250', '500'], 'Weight'),
    length(['m', 'cm'], ['5', '10', '50', '100']),
    measure('gsm', 'Thickness or GSM', ['gsm', 'mm'], { suggestions: ['120', '180', '220', '300'] }),
    packCount(['1', '6', '12', '24', '50']),
    choice('finish', 'Finish', ['Matt', 'Glossy', 'Metallic', 'Glitter', 'Pearl']),
    flag('washable', 'Washable', ['Washable', 'Permanent']),
  ]),

  template('toys-hobbies-crafts', 'musical-instruments', 'Musical Instruments', [
    choice('instrument_type', 'Instrument', ['Acoustic guitar', 'Electric guitar', 'Keyboard', 'Tabla', 'Violin', 'Ukulele'], {
      importance: 'RECOMMENDED',
    }),
    choice('instrument_size', 'Size', ['1/2', '3/4', '4/4', 'Full size', '38 in', '41 in'], {
      importance: 'RECOMMENDED',
    }),
    finish(['Natural', 'Gloss', 'Matt', 'Sunburst']),
    colour(['Natural', 'Black', 'Sunburst', 'Red', 'Blue']),
    choice('handing', 'Handedness', ['Right handed', 'Left handed'], { allowsCustomValues: false }),
    choice('bundle', 'Supplied as', ['Instrument only', 'With bag', 'Complete bundle']),
    choice('string_type', 'Strings or keys', ['Nylon strings', 'Steel strings', '61 keys', '76 keys', '88 keys']),
    flag('electronics', 'Pickup', ['With pickup', 'Acoustic only']),
  ]),

  template('toys-hobbies-crafts', 'gifts-party', 'Gifts & Party', [
    choice('product_type', 'Type', ['Balloon', 'Gift box', 'Banner', 'Party hat', 'Candle', 'Gift wrap'], {
      importance: 'RECOMMENDED',
    }),
    choice('theme', 'Theme', ['Birthday', 'Wedding', 'Anniversary', 'Festive', 'Corporate', 'Baby shower']),
    colour(['Assorted', 'Gold', 'Silver', 'Pink', 'Blue'], 'RECOMMENDED'),
    measure('size', 'Size', ['cm', 'in'], { suggestions: ['10', '12', '18', '24'] }),
    choice('personalisation', 'Personalisation', ['Not personalised', 'Name printed', 'Custom message'], {
      allowsCustomValues: false,
    }),
    packCount(['1', '10', '25', '50', '100']),
    material(['Latex', 'Foil', 'Paper', 'Fabric', 'Wood']),
    ageGroup(['Kids', 'Teen', 'Adult']),
  ]),
];

// ---------------------------------------------------------------------------
// 22. BOOKS & MEDIA
// ---------------------------------------------------------------------------

const BOOKS: readonly VariantTemplate[] = [
  template('books-media', 'books', 'Books', [
    choice('format', 'Format', ['Paperback', 'Hardcover', 'E-book', 'Audiobook'], {
      importance: 'RECOMMENDED',
      allowsCustomValues: false,
    }),
    choice('edition', 'Edition', ['1st edition', '2nd edition', '3rd edition', 'Revised', 'Anniversary']),
    choice('language', 'Language', ['English', 'Hindi', 'German', 'French', 'Spanish'], {
      importance: 'RECOMMENDED',
    }),
    choice('volume', 'Volume', ['Volume 1', 'Volume 2', 'Volume 3', 'Complete set']),
    choice('isbn', 'ISBN', [], { inTitle: false }),
    choice('binding', 'Binding', ['Perfect bound', 'Case bound', 'Spiral', 'Saddle stitch']),
    choice('page_count', 'Pages', ['Under 200', '200-400', '400-700', 'Over 700'], { inTitle: false }),
  ]),

  template('books-media', 'educational-materials', 'Educational Materials', [
    choice('material_type', 'Type', ['Textbook', 'Workbook', 'Chart', 'Model kit', 'Flash cards', 'Lab manual'], {
      importance: 'RECOMMENDED',
    }),
    choice('grade_level', 'Grade or age level', ['Pre-primary', 'Class 1-5', 'Class 6-8', 'Class 9-10', 'Class 11-12', 'Undergraduate'], {
      importance: 'RECOMMENDED',
    }),
    choice('subject', 'Subject', ['Mathematics', 'Science', 'English', 'Social studies', 'Computer science']),
    choice('language', 'Language', ['English', 'Hindi', 'Regional']),
    choice('format', 'Format', ['Print', 'Digital', 'Print and digital']),
    choice('edition', 'Edition', ['Latest edition', 'Previous edition']),
    pieceCount(['1', '2', '5', '10'], 'Items in set'),
    choice('board', 'Board or syllabus', ['CBSE', 'ICSE', 'State board', 'IB', 'Cambridge']),
    flag('solutions_included', 'Solutions', ['With solutions', 'Without solutions']),
  ]),

  template('books-media', 'audio-video', 'Audio & Video', [
    choice('format', 'Format', ['CD', 'DVD', 'Blu-ray', 'Vinyl', 'Digital download'], {
      importance: 'RECOMMENDED',
      allowsCustomValues: false,
    }),
    choice('edition', 'Edition', ['Standard', 'Special edition', 'Collectors edition', 'Remastered']),
    choice('region', 'Region', ['Region free', 'Region 1', 'Region 2', 'Region 5']),
    choice('language', 'Language', ['English', 'Hindi', 'Multi-language']),
    choice('resolution', 'Resolution or quality', ['SD', 'HD', '4K UHD', 'Stereo', '5.1 surround']),
    choice('disc_count', 'Discs', ['1', '2', '3', '5', '10']),
    choice('subtitles', 'Subtitles', ['None', 'English', 'Multiple languages']),
    choice('packaging', 'Packaging', ['Standard case', 'Steelbook', 'Digipak', 'Box set']),
  ]),
];

// ---------------------------------------------------------------------------
// 23. CHEMICALS & RAW MATERIALS
// ---------------------------------------------------------------------------

const CHEMICALS: readonly VariantTemplate[] = [
  template('chemicals-raw-materials', 'industrial-chemicals', 'Industrial Chemicals', [
    choice('chemical_type', 'Chemical', [], { importance: 'RECOMMENDED' }),
    grade(['Technical', 'Industrial', 'LR', 'AR', 'Food grade'], 'Grade'),
    measure('concentration', 'Concentration or purity', ['%'], {
      importance: 'RECOMMENDED',
      suggestions: ['90', '95', '98', '99', '99.5'],
    }),
    choice('physical_form', 'Physical form', ['Liquid', 'Powder', 'Flake', 'Granule', 'Pellet']),
    netWeight(['1', '5', '25', '50', '200'], 'Net weight'),
    netVolume(['1', '5', '20', '200'], 'Net volume'),
    choice('container_type', 'Container', ['Bottle', 'Carboy', 'Jerrycan', 'Drum', 'HDPE bag', 'IBC']),
    choice('hazard_class', 'Transport class', ['Non-hazardous', 'Class 3', 'Class 8', 'Class 9']),
    choice('storage', 'Storage', ['Ambient', 'Cool and dry', 'Refrigerated']),
  ]),

  template('chemicals-raw-materials', 'plastics-polymers', 'Plastics & Polymers', [
    choice('resin_type', 'Resin', ['LDPE', 'HDPE', 'PP', 'PVC', 'PET', 'ABS', 'Nylon'], {
      importance: 'RECOMMENDED',
    }),
    grade(['Injection moulding', 'Blow moulding', 'Film grade', 'Extrusion'], 'Grade'),
    choice('form', 'Form', ['Granule', 'Powder', 'Sheet', 'Rod', 'Film']),
    colour(['Natural', 'Black', 'White', 'Transparent', 'Masterbatch']),
    measure('melt_flow', 'Melt flow or density', ['g/10min', 'g/cm3'], { suggestions: ['0.5', '2', '12', '0.92', '0.95'] }),
    netWeight(['1', '25', '500', '1000'], 'Pack weight'),
    flag('recycled', 'Origin', ['Virgin', 'Recycled']),
    choice('additive', 'Additive', ['None', 'UV stabilised', 'Flame retardant', 'Anti-static']),
  ]),

  template('chemicals-raw-materials', 'metals-alloys', 'Metals & Alloys', [
    grade(['Mild steel', 'SS 304', 'SS 316', 'Aluminium 6061', 'Brass', 'Copper'], 'Metal or alloy grade'),
    choice('form', 'Form', ['Sheet', 'Plate', 'Bar', 'Pipe', 'Angle', 'Coil'], { importance: 'RECOMMENDED' }),
    measure('dimensions', 'Dimensions', ['mm', 'in', 'ft'], { importance: 'RECOMMENDED' }),
    measure('thickness', 'Thickness or gauge', ['mm', 'SWG'], {
      importance: 'RECOMMENDED',
      suggestions: ['0.5', '1', '1.6', '2', '3', '5', '10'],
    }),
    finish(['Hot rolled', 'Cold rolled', 'Mill finish', '2B', 'Mirror polish', 'Galvanised']),
    choice('temper', 'Temper', ['Annealed', 'H14', 'H24', 'T6']),
    length(['mm', 'm', 'ft'], ['1', '2', '3', '6']),
    netWeight(['1', '25', '100', '1000'], 'Weight'),
    choice('standard', 'Standard', ['IS', 'ASTM', 'EN', 'JIS'], { inTitle: false }),
    choice('edge_condition', 'Edge', ['Mill edge', 'Slit edge', 'Sheared', 'Laser cut']),
  ]),

  template('chemicals-raw-materials', 'rubber-sealing', 'Rubber & Sealing', [
    choice('product_type', 'Type', ['O-ring', 'Oil seal', 'Gasket sheet', 'Rubber cord', 'Bellow', 'Rubber mat'], {
      importance: 'RECOMMENDED',
    }),
    material(['NBR', 'EPDM', 'Silicone', 'Viton (FKM)', 'Neoprene', 'Natural rubber']),
    measure('inner_diameter', 'Inner diameter', ['mm', 'in'], { importance: 'RECOMMENDED' }),
    measure('outer_diameter', 'Outer diameter', ['mm', 'in']),
    measure('thickness', 'Thickness or section', ['mm'], { suggestions: ['1', '1.5', '2', '3', '5'] }),
    measure('hardness', 'Hardness', ['Shore A'], { suggestions: ['50', '60', '70', '80', '90'] }),
    measure('temperature_range', 'Temperature or pressure rating', ['C', 'bar']),
    packCount(['1', '10', '25', '50', '100']),
    colour(['Black', 'Red', 'Green', 'White', 'Brown']),
    choice('standard', 'Standard', ['AS568', 'BS1806', 'JIS', 'Metric'], { inTitle: false }),
  ]),
];

// ---------------------------------------------------------------------------
// 24. ENERGY & ENVIRONMENT
// ---------------------------------------------------------------------------

const ENERGY: readonly VariantTemplate[] = [
  template('energy-environment', 'solar-renewables', 'Solar & Renewables', [
    choice('product_type', 'Type', ['Solar panel', 'Inverter', 'Charge controller', 'Mounting structure', 'Solar battery'], {
      importance: 'RECOMMENDED',
    }),
    measure('power_rating', 'Power rating', ['W', 'kW', 'kVA'], {
      importance: 'RECOMMENDED',
      suggestions: ['100', '335', '400', '540', '3', '5'],
    }),
    measure('voltage_rating', 'Voltage', ['V'], { suggestions: ['12', '24', '48'] }),
    choice('cell_technology', 'Cell or technology', ['Polycrystalline', 'Monocrystalline', 'Mono PERC', 'Bifacial', 'Thin film'], {
      importance: 'RECOMMENDED',
    }),
    measure('dimensions', 'Dimensions', ['mm']),
    choice('connector', 'Connector', ['MC4', 'Bare wire', 'Anderson']),
    choice('system_configuration', 'System configuration', ['On grid', 'Off grid', 'Hybrid'], {
      allowsCustomValues: false,
    }),
    choice('cell_count', 'Cells', ['36', '60', '72', '120', '144']),
    choice('warranty', 'Warranty', ['5 years', '10 years', '25 years'], { inTitle: false }),
  ]),

  template('energy-environment', 'generators-backup-power', 'Generators & Backup Power', [
    choice('fuel_type', 'Fuel', ['Diesel', 'Petrol', 'Gas', 'Dual fuel', 'Battery'], { importance: 'RECOMMENDED' }),
    measure('power_rating', 'Rated output', ['kVA', 'kW'], {
      importance: 'RECOMMENDED',
      suggestions: ['2', '5', '7.5', '10', '15', '25', '50'],
    }),
    choice('phase', 'Phase', ['Single phase', 'Three phase'], { importance: 'RECOMMENDED' }),
    voltage(['230 V', '415 V']),
    choice('start_type', 'Start', ['Recoil start', 'Electric start', 'Auto start (AMF)']),
    capacity(['L', 'h'], ['5', '10', '15', '50']),
    choice('enclosure', 'Enclosure', ['Open frame', 'Silent canopy', 'Weatherproof']),
    choice('accessories', 'Included accessories', ['Unit only', 'With ATS', 'With trolley']),
    choice('cooling', 'Cooling', ['Air cooled', 'Water cooled']),
    measure('noise_level', 'Noise level', ['dB'], { suggestions: ['58', '65', '72', '75'] }),
  ]),

  template('energy-environment', 'water-treatment', 'Water Treatment', [
    choice('equipment_type', 'Type', ['RO system', 'UV steriliser', 'Water softener', 'Sediment filter', 'Carbon filter', 'RO membrane'], {
      importance: 'RECOMMENDED',
    }),
    measure('flow_capacity', 'Flow capacity', ['LPH', 'GPD', 'L/min'], {
      importance: 'RECOMMENDED',
      suggestions: ['25', '50', '75', '100', '250', '500'],
    }),
    choice('filtration_stage', 'Stages', ['1 stage', '3 stage', '5 stage', '7 stage', '9 stage']),
    measure('micron_rating', 'Micron rating', ['micron'], { suggestions: ['0.5', '1', '5', '10', '20'] }),
    measure('membrane_size', 'Membrane size', ['in'], { suggestions: ['1812', '2012', '2812', '4040'] }),
    voltage(),
    packCount(['1', '2', '3', '5', '10']),
    choice('mounting', 'Mounting', ['Wall mounted', 'Counter top', 'Under sink', 'Floor standing']),
    measure('tank_capacity', 'Storage tank', ['L'], { suggestions: ['6', '8', '10', '12'] }),
  ]),

  template('energy-environment', 'air-quality', 'Air Quality', [
    choice('device_type', 'Type', ['Air purifier', 'HEPA filter', 'Carbon filter', 'Air quality monitor', 'Dehumidifier'], {
      importance: 'RECOMMENDED',
    }),
    measure('coverage_area', 'Coverage area', ['m2', 'sq ft'], {
      importance: 'RECOMMENDED',
      suggestions: ['20', '30', '50', '70', '100'],
    }),
    measure('airflow', 'Airflow (CADR)', ['m3/h', 'CFM'], { suggestions: ['150', '250', '350', '500'] }),
    grade(['HEPA H11', 'HEPA H13', 'HEPA H14', 'Activated carbon', 'PM2.5 sensor'], 'Sensor or filter grade'),
    measure('power', 'Power', ['W'], { suggestions: ['30', '45', '60', '100'] }),
    colour(['White', 'Black', 'Silver']),
    packCount(['1', '2', '3', '4']),
    choice('filter_stages', 'Filter stages', ['2 stage', '3 stage', '4 stage', 'HEPA + carbon']),
    measure('noise_level', 'Noise level', ['dB'], { suggestions: ['25', '35', '45', '55'] }),
  ]),
];

export const CONSUMER_TEMPLATES: readonly VariantTemplate[] = Object.freeze([
  ...CLOTHING,
  ...BEAUTY,
  ...SPORTS,
  ...TOYS,
  ...BOOKS,
  ...CHEMICALS,
  ...ENERGY,
]);
