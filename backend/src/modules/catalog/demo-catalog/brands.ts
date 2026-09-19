/**
 * The brands the demonstration catalogue sells under.
 *
 * ALL OF THEM ARE INVENTED, and that is not a detail. Putting a real
 * manufacturer's name on a fabricated product with a fabricated specification
 * and a fabricated price is passing off, and it does not stop being passing
 * off because the catalogue was labelled a demonstration: screenshots get
 * circulated, exports get imported, and the name on the card is the part that
 * travels.
 *
 * So these are trade-plausible names that belong to nobody. They are checked
 * against the real world in one direction only - none of them is a company
 * this repository's authors could find - and a deployment that discovers a
 * collision should rename the entry here rather than leave it.
 *
 * A brand means the same supplier wherever it appears. `Kestrel` is the tool
 * house in three departments, not a name picked at random each time, because a
 * catalogue where the brand column is noise is a catalogue whose brand facet
 * is useless - and the brand facet is one of the two or three filters a trade
 * buyer actually uses.
 */

/** Fictional suppliers, grouped by the kind of thing they make. */
export const BRANDS = Object.freeze({
  // --- clinical and laboratory ---------------------------------------
  /** Single-use clinical consumables. */
  medline: 'Ardenmed',
  /** Vascular access and infusion. */
  vascular: 'Vantril',
  /** Enteral and oral dosing. */
  enteral: 'Nutriflow',
  /** Laboratory instruments and calibration. */
  lab: 'Cavendish Scientific',
  /** Laboratory glass, plastics and reagents. */
  reagent: 'Borosil Works',

  // --- industry and trade ---------------------------------------------
  /** Fasteners, bearings and power transmission. */
  industrial: 'Northgate Industrial',
  /** Hydraulics, pneumatics, pumps and valves. */
  fluid: 'Halcyon Fluidtech',
  /** Abrasives, welding and consumable tooling. */
  abrasive: 'Forgeline',
  /** Hand tools, power tools and storage. */
  tools: 'Kestrel Tools',
  /** Cutting tools and precision measurement. */
  precision: 'Merian Precision',

  // --- electrical and electronic ---------------------------------------
  /** Cable, wiring accessories and circuit protection. */
  electrical: 'Volterra Electric',
  /** Lighting. */
  lighting: 'Lumicast',
  /** Motors, drives and power conversion. */
  drives: 'Axonar Drives',
  /** Components, sensors and test equipment. */
  electronics: 'Ferrite Labs',

  // --- technology --------------------------------------------------------
  /** Computers and peripherals. */
  computing: 'Corveta',
  /** Networking and storage. */
  network: 'Netgrid',
  /** Phones, radios and telephony. */
  comms: 'Talora',
  /** Software and licensing. */
  software: 'Quarrow Software',

  // --- workplace ----------------------------------------------------------
  /** Paper, writing and filing. */
  office: 'Penmarc',
  /** Office machines and print consumables. */
  machines: 'Clerica',
  /** Corrugated, tape, film and labels. */
  packaging: 'Palletrade',
  /** Personal protective equipment. */
  safety: 'Sentrik',
  /** Safety footwear and protective clothing. */
  workwear: 'Ironpath',
  /** Cleaning chemicals and janitorial equipment. */
  cleaning: 'Aquline',

  // --- built environment ---------------------------------------------------
  /** Building materials and surface finishing. */
  building: 'Marbrick',
  /** Plumbing, heating, ventilation and cooling. */
  plumbing: 'Thermex',
  /** Doors, windows and ironmongery. */
  ironmongery: 'Oakbarrow',

  // --- transport and land ---------------------------------------------------
  /** Vehicle parts, tyres and garage equipment. */
  automotive: 'Torqline',
  /** Vehicle care chemicals. */
  carcare: 'Glosswerk',
  /** Farm machinery, irrigation and garden tools. */
  agri: 'Greenfurrow',
  /** Seeds, feed and fertiliser. */
  seed: 'Terravita',

  // --- hospitality and home ---------------------------------------------------
  /** Commercial kitchen equipment and refrigeration. */
  catering: 'Copperline',
  /** Tableware, serving and disposables. */
  tableware: 'Servora',
  /** Office and commercial furniture. */
  furniture: 'Alderwood',
  /** Domestic appliances and kitchenware. */
  home: 'Hearthline',
  /** Bedding, bath and soft furnishing. */
  textile: 'Loomfield',

  // --- consumer ------------------------------------------------------------------
  /** Everyday clothing and footwear. */
  apparel: 'Ravelle',
  /** Skin, hair and personal care. */
  beauty: 'Lumea Botanics',
  /** Sports, fitness and outdoor. */
  sport: 'Altura Sport',
  /** Toys, crafts and party. */
  play: 'Brightloom',
  /** Musical instruments. */
  music: 'Cadenza Works',
  /** Books, educational materials and media. */
  media: 'Quillport Press',

  // --- materials and energy ----------------------------------------------------------
  /** Industrial chemicals and polymers. */
  chemical: 'Solvanta',
  /** Metals, alloys and sealing. */
  metals: 'Ferralis',
  /** Solar, generators, water and air. */
  energy: 'Solvance Energy',
} as const);
