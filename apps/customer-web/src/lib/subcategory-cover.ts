/**
 * Which photograph a sub-category gets on its department's rail.
 *
 * The sibling of `lib/category-cover.ts`, one level down. That file dresses
 * the twenty-five departments; this dresses what is filed inside them, because
 * the rail a department opens into is made of photographs and a rail of grey
 * plates is not a rail anybody browses.
 *
 * WHY A TABLE RATHER THAN A PATTERN LIST
 *
 * `category-cover.ts` matches on regular expressions, and it is right to: a
 * department is a broad word and "Tools", "Tooling" and "Hand Tools" all want
 * the same picture. A sub-category is the opposite. "Tyres & Wheels" and
 * "Vehicle Care" are both inside Automotive and want different photographs,
 * and a pattern loose enough to catch either would catch both. So this is an
 * exact table, keyed on the name with its punctuation flattened, and a name
 * that is not in it simply has no photograph.
 *
 * WHY A CATEGORY HAS NO IMAGE COLUMN, AGAIN
 *
 * The same reason `category-cover.ts` gives, and it is worth repeating because
 * it is the question this file invites: a fresh deployment of this product has
 * to look finished with nothing supplied. Putting an image on `Category` would
 * mean an operator uploading a hundred and thirty-eight photographs before
 * their catalogue stopped looking broken. This dresses the starter catalogue's
 * own names and leaves everything else to the drawn plate.
 *
 * WHAT A MISS LOOKS LIKE
 *
 * Nothing breaks. `subCategoryCover` returns `null`, and the rail draws the
 * department's own mark on a brand plate instead — see `SubCategoryRail`.
 * Nobody is shown a photograph of something that is not what they sell.
 *
 * ONE THING TO KNOW BEFORE ADDING A ROW
 *
 * Most of these are Unsplash's CDN, which is stable and built to be hotlinked.
 * A minority are product photographs on suppliers' own sites, which is not:
 * those hosts may add hotlink protection, move the file, or simply go away,
 * and the day one of them does, that rail card falls back to the drawn plate
 * with no other consequence. That is the trade, it is deliberate, and it is
 * why the fallback is a real card rather than a broken-image icon.
 */

/**
 * Name to photograph, for the starter catalogue's sub-categories.
 *
 * Keys are the sub-category name with punctuation flattened to single spaces
 * and lower-cased — see `flatten` below, which is the only thing allowed to
 * build one. Grouped by department and in the department's own order, so a row
 * is added next to its siblings rather than at the bottom.
 */
const COVERS: Readonly<Record<string, string>> = Object.freeze({
  // --- Medical Devices -----------------------------------------------
  "abg kit":
    "https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48",
  "abg syringe":
    "https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48",
  "adult diaper":
    "https://cdn.shopify.com/s/files/1/0625/3402/5474/files/1_deeef9d4-ffdd-4d3e-9cae-18947c579005_400x.jpg?v=1760174433",
  "closed iv cannula":
    "https://d2t0svjwo1hj60.cloudfront.net/media/public/b9d6a2bdbc154d059_image.png",
  "dc flush syringe swab cap":
    "https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48",
  "disinfectant cap":
    "https://d2t0svjwo1hj60.cloudfront.net/media/public/b9d6a2bdbc154d059_image.png",
  "enfit syringe":
    "https://ukmedi.co.uk/cdn/shop/files/medicina-60ml-enfit-medicina-syringe-lpe60-ukmedi-uk-medical-supplies__39347_1657086920_1280_1280.jpg?v=1728563002&width=1445",
  "flush syringe":
    "https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48",
  "infant feeding tube":
    "https://oralkart.com/cdn/shop/files/Romsons_Infant_Feeding_Tube_with_Graduated_Scale_FEEDY_GS-4038.webp?v=1752136773",
  "infusion set":
    "https://www.zrmed.com/uploads/2012/iv-infusion-set-manufacturer.jpg",
  "insulin syringe":
    "https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48",
  "iv cannula":
    "https://d2t0svjwo1hj60.cloudfront.net/media/public/b9d6a2bdbc154d059_image.png",
  "line access":
    "https://d2t0svjwo1hj60.cloudfront.net/media/public/b9d6a2bdbc154d059_image.png",
  "oral dosing syringe":
    "https://www.rehabmart.com/imagesfromrd/Purple~3.jpg",
  "oral syiringe":
    "https://www.rehabmart.com/imagesfromrd/Purple~3.jpg",
  "prefilled heparin syringe":
    "https://www.mountainside-medical.com/cdn/shop/files/Heparin-Sodium-Injection-Prefilled-Syringes-5000-Units-Per-1-mL-by-Hikma_1200x1200.jpg?v=1713447273",
  "ryles tube":
    "https://oralkart.com/cdn/shop/files/Romsons_Infant_Feeding_Tube_with_Graduated_Scale_FEEDY_GS-4038.webp?v=1752136773",
  "safety needle":
    "https://www.mountainside-medical.com/cdn/shop/files/Heparin-Sodium-Injection-Prefilled-Syringes-5000-Units-Per-1-mL-by-Hikma_1200x1200.jpg?v=1713447273",
  "sodium citrate prefilled syringe":
    "https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48",
  "sterile water":
    "https://mentorsolutions.ca/cdn/shop/files/IMG-3579.jpg?v=1759955342&width=2048",
  "sterile water with 10 glycerine":
    "https://mentorsolutions.ca/cdn/shop/files/IMG-3579.jpg?v=1759955342&width=2048",
  "suction catheter":
    "https://www.gpmedline.com/cdn/shop/files/1SC12-Suction_Catheter_With_Thumb_Control_Size_12.webp?v=1725943369&width=1445",
  "surgical gloves":
    "https://thehospitalwarehouse.com/cdn/shop/files/box-of-sterile-surgical-gloves_1533x1022.png?v=1760695177",
  "line conditioning":
    "https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48",
  "iv administration sets":
    "https://www.zrmed.com/uploads/2012/iv-infusion-set-manufacturer.jpg",
  "syringes needles":
    "https://www.mountainside-medical.com/cdn/shop/files/Heparin-Sodium-Injection-Prefilled-Syringes-5000-Units-Per-1-mL-by-Hikma_1200x1200.jpg?v=1713447273",

  // --- Laboratory & Scientific ---------------------------------------
  "lab instruments":
    "https://images.unsplash.com/photo-1614308460927-5024ba2e1dcb?q=80&w=1200&auto=format&fit=crop",
  "glassware plasticware":
    "https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?q=80&w=1000&auto=format&fit=crop",
  "reagents chemicals":
    "https://images.unsplash.com/photo-1614935151651-0bea31271328?q=80&w=1000&auto=format&fit=crop",
  "consumables sampling":
    "https://images.unsplash.com/photo-1579154204601-01588f351e67?q=80&w=1200&auto=format&fit=crop",
  "measurement calibration":
    "https://images.unsplash.com/photo-1581092335397-9583fe92d232?q=80&w=1200&auto=format&fit=crop",

  // --- Industrial Supplies -------------------------------------------
  "fasteners fixings":
    "https://images.unsplash.com/photo-1608613304899-2821217e2f5b?q=80&w=1000&auto=format&fit=crop",
  "bearings power transmission":
    "https://images.unsplash.com/photo-1504917599217-d4dc5ebe6122?q=80&w=1000&auto=format&fit=crop",
  "hydraulics pneumatics":
    "https://images.unsplash.com/photo-1581092335397-9583fe92d232?q=80&w=1000&auto=format&fit=crop",
  "pumps valves":
    "https://images.unsplash.com/photo-1581092160607-ee22621dd758?q=80&w=1000&auto=format&fit=crop",
  "abrasives":
    "https://images.unsplash.com/photo-1504307651254-35680f356dfd?q=80&w=1000&auto=format&fit=crop",
  "lubricants adhesives":
    "https://images.unsplash.com/photo-1615811361523-6bd03d7748e7?q=80&w=1000&auto=format&fit=crop",
  "welding soldering":
    "https://images.unsplash.com/photo-1504307651254-35680f356dfd?q=80&w=1000&auto=format&fit=crop",
  "material handling":
    "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?q=80&w=1000&auto=format&fit=crop",

  // --- Tools & Hardware ----------------------------------------------
  "hand tools":
    "https://images.unsplash.com/photo-1581147036324-c17ac41dfa6c?q=80&w=1000&auto=format&fit=crop",
  "power tools":
    "https://images.unsplash.com/photo-1504148455328-c376907d081c?q=80&w=1000&auto=format&fit=crop",
  "cutting tools":
    "https://images.unsplash.com/photo-1530124566582-a618bc2615dc?q=80&w=1000&auto=format&fit=crop",
  "measuring layout":
    "https://images.unsplash.com/photo-1581092160607-ee22621dd758?q=80&w=1000&auto=format&fit=crop",
  "tool storage":
    "https://images.unsplash.com/photo-1586864387967-d02ef85d93e8?q=80&w=1000&auto=format&fit=crop",

  // --- Electrical & Lighting -----------------------------------------
  "cables wiring":
    "https://images.unsplash.com/photo-1767514536570-83d70c024247?q=80&w=1200&auto=format&fit=crop",
  "switches sockets":
    "https://images.unsplash.com/photo-1767514536570-83d70c024247?q=80&w=1200&auto=format&fit=crop",
  "circuit protection":
    "https://images.unsplash.com/photo-1767514536570-83d70c024247?q=80&w=1200&auto=format&fit=crop",
  "motors drives":
    "https://images.unsplash.com/photo-1581092160607-ee22621dd758?q=80&w=1000&auto=format&fit=crop",
  "lighting":
    "https://images.unsplash.com/photo-1507473885765-e6ed057f782c?q=80&w=1000&auto=format&fit=crop",
  "batteries power supplies":
    "https://images.unsplash.com/photo-1619725002198-6a689b72f41d?q=80&w=1000&auto=format&fit=crop",

  // --- Electronics & Components --------------------------------------
  "electronic components":
    "https://images.unsplash.com/photo-1518770660439-4636190af475?q=80&w=1000&auto=format&fit=crop",
  "sensors automation":
    "https://images.unsplash.com/photo-1517077304055-6e89abbf09b0?q=80&w=1000&auto=format&fit=crop",
  "test measurement":
    "https://images.unsplash.com/photo-1581092335397-9583fe92d232?q=80&w=1000&auto=format&fit=crop",
  "enclosures connectors":
    "https://images.unsplash.com/photo-1697071327741-04319e5d54d3?q=80&w=1200&auto=format&fit=crop",

  // --- Computers & IT ------------------------------------------------
  "laptops desktops":
    "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?q=80&w=1000&auto=format&fit=crop",
  "peripherals accessories":
    "https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?q=80&w=1000&auto=format&fit=crop",
  "networking":
    "https://images.unsplash.com/photo-1544197150-b99a580bb7a8?q=80&w=1000&auto=format&fit=crop",
  "storage media":
    "https://images.unsplash.com/photo-1597872200969-2b65d56bd16b?q=80&w=1000&auto=format&fit=crop",
  "printers scanners":
    "https://images.unsplash.com/photo-1612815154858-60aa4c59eaa6?q=80&w=1000&auto=format&fit=crop",
  "software licences":
    "https://images.unsplash.com/photo-1555066931-4365d14bab8c?q=80&w=1000&auto=format&fit=crop",

  // --- Phones & Communication ----------------------------------------
  "mobile phones":
    "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?q=80&w=1000&auto=format&fit=crop",
  "phone accessories":
    "https://images.unsplash.com/photo-1583394838336-acd977736f90?q=80&w=1000&auto=format&fit=crop",
  "two way radios":
    "https://images.unsplash.com/photo-1520923642038-b4259acecbd7?q=80&w=1200&auto=format&fit=crop",
  "telephony":
    "https://images.unsplash.com/photo-1520923642038-b4259acecbd7?q=80&w=1000&auto=format&fit=crop",

  // --- Office & Stationery -------------------------------------------
  "paper notebooks":
    "https://images.unsplash.com/photo-1517842645767-c639042777db?q=80&w=1000&auto=format&fit=crop",
  "writing correction":
    "https://images.unsplash.com/photo-1585336261026-61e778f29280?q=80&w=1000&auto=format&fit=crop",
  "filing organisation":
    "https://images.unsplash.com/photo-1586281380349-632531db7ed4?q=80&w=1000&auto=format&fit=crop",
  "office machines":
    "https://images.unsplash.com/photo-1612815154858-60aa4c59eaa6?q=80&w=1000&auto=format&fit=crop",
  "printer supplies":
    "https://images.unsplash.com/photo-1612815154858-60aa4c59eaa6?q=80&w=1200&auto=format&fit=crop",

  // --- Packaging & Shipping ------------------------------------------
  "boxes cartons":
    "https://images.unsplash.com/photo-1769355104335-acef3aa4c9b6?q=80&w=1200&auto=format&fit=crop",
  "tapes strapping":
    "https://images.unsplash.com/photo-1589939705384-5185137a7f0f?q=80&w=1000&auto=format&fit=crop",
  "protective packaging":
    "https://images.unsplash.com/photo-1607166452427-7e4477079cb9?q=80&w=1000&auto=format&fit=crop",
  "bags films":
    "https://images.unsplash.com/photo-1769355104335-acef3aa4c9b6?q=80&w=1200&auto=format&fit=crop",
  "labels marking":
    "https://images.unsplash.com/photo-1769355104335-acef3aa4c9b6?q=80&w=1200&auto=format&fit=crop",

  // --- Safety & Protective Equipment ---------------------------------
  "hand protection":
    "https://thehospitalwarehouse.com/cdn/shop/files/box-of-sterile-surgical-gloves_1533x1022.png?v=1760695177",
  "eye face protection":
    "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?q=80&w=1000&auto=format&fit=crop",
  "respiratory protection":
    "https://images.unsplash.com/photo-1584634731339-252c581abfc5?q=80&w=1000&auto=format&fit=crop",
  "head fall protection":
    "https://images.unsplash.com/photo-1788883439454-81b23fe50588?q=80&w=1200&auto=format&fit=crop",
  "protective clothing":
    "https://images.unsplash.com/photo-1607613009820-a29f7bb81c04?q=80&w=1000&auto=format&fit=crop",
  "safety footwear":
    "https://images.unsplash.com/photo-1542291026-7eec264c27ff?q=80&w=1000&auto=format&fit=crop",
  "fire safety first aid":
    "https://images.unsplash.com/photo-1603398938378-e54eab446dde?q=80&w=1000&auto=format&fit=crop",

  // --- Cleaning & Hygiene --------------------------------------------
  "cleaning chemicals":
    "https://images.unsplash.com/photo-1585421514284-efb74c2b69ba?q=80&w=1000&auto=format&fit=crop",
  "disinfection sterilisation":
    "https://images.unsplash.com/photo-1584515933487-779824d29309?q=80&w=1000&auto=format&fit=crop",
  "cleaning equipment":
    "https://images.unsplash.com/photo-1581578731548-c64695cc6952?q=80&w=1000&auto=format&fit=crop",
  "washroom supplies":
    "https://images.unsplash.com/photo-1759846866217-e627e4478f82?q=80&w=1200&auto=format&fit=crop",
  "waste management":
    "https://images.unsplash.com/photo-1532996122724-e3c354a0b15b?q=80&w=1000&auto=format&fit=crop",

  // --- Building & Construction ---------------------------------------
  "building materials":
    "https://images.unsplash.com/photo-1775049525141-783d72f14ca1?q=80&w=1200&auto=format&fit=crop",
  "plumbing sanitary":
    "https://images.unsplash.com/photo-1585704032915-c3400ca199e7?q=80&w=1000&auto=format&fit=crop",
  "heating ventilation cooling":
    "https://images.unsplash.com/photo-1621905251189-08b45d6a269e?q=80&w=1000&auto=format&fit=crop",
  "paint surface finishing":
    "https://images.unsplash.com/photo-1562259949-e8e7689d7828?q=80&w=1000&auto=format&fit=crop",
  "doors windows ironmongery":
    "https://images.unsplash.com/photo-1513694203232-719a280e022f?q=80&w=1000&auto=format&fit=crop",

  // --- Automotive & Transport ----------------------------------------
  "vehicle parts":
    "https://images.unsplash.com/photo-1783427401156-aaf899c76ecb?q=80&w=1200&auto=format&fit=crop",
  "tyres wheels":
    "https://images.unsplash.com/photo-1578844251758-2f71da64c96f?q=80&w=1000&auto=format&fit=crop",
  "garage equipment":
    "https://images.unsplash.com/photo-1530046339160-ce3e530c7d2f?q=80&w=1000&auto=format&fit=crop",
  "vehicle care":
    "https://images.unsplash.com/photo-1607860108855-64acf2078ed9?q=80&w=1000&auto=format&fit=crop",

  // --- Agriculture & Gardening ---------------------------------------
  "farm equipment":
    "https://images.unsplash.com/photo-1500937386664-56d1dfef3854?q=80&w=1000&auto=format&fit=crop",
  "irrigation":
    "https://images.unsplash.com/photo-1563514227147-6d2ff665a6a0?q=80&w=1000&auto=format&fit=crop",
  "seeds feed fertiliser":
    "https://images.unsplash.com/photo-1416879595882-3373a0480b5b?q=80&w=1000&auto=format&fit=crop",
  "garden tools outdoor":
    "https://images.unsplash.com/photo-1763844597656-eddb0836065f?q=80&w=1200&auto=format&fit=crop",

  // --- Food Service & Catering ---------------------------------------
  "commercial kitchen equipment":
    "https://images.unsplash.com/photo-1778837224430-bc0f32c27f53?q=80&w=1200&auto=format&fit=crop",
  "tableware serving":
    "https://images.unsplash.com/photo-1578749556568-bc2c40e68b61?q=80&w=1000&auto=format&fit=crop",
  "disposables takeaway":
    "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?q=80&w=1000&auto=format&fit=crop",
  "food storage refrigeration":
    "https://images.unsplash.com/photo-1584269600464-37b1b58a9fe7?q=80&w=1000&auto=format&fit=crop",

  // --- Furniture & Fixtures ------------------------------------------
  "office furniture":
    "https://images.unsplash.com/photo-1497215728101-856f4ea42174?q=80&w=1000&auto=format&fit=crop",
  "seating":
    "https://images.unsplash.com/photo-1580481072645-022f9a6d8310?q=80&w=1000&auto=format&fit=crop",
  "storage shelving":
    "https://images.unsplash.com/photo-1595428774223-ef52624120d2?q=80&w=1000&auto=format&fit=crop",
  "retail display":
    "https://images.unsplash.com/photo-1441986300917-64674bd600d8?q=80&w=1000&auto=format&fit=crop",

  // --- Home & Kitchen ------------------------------------------------
  "kitchenware":
    "https://images.unsplash.com/photo-1777499455332-ec8800b7c197?q=80&w=1200&auto=format&fit=crop",
  "home appliances":
    "https://images.unsplash.com/photo-1584269600464-37b1b58a9fe7?q=80&w=1000&auto=format&fit=crop",
  "bedding bath":
    "https://images.unsplash.com/photo-1616627781431-23b776ada33d?q=80&w=1000&auto=format&fit=crop",
  "home decor":
    "https://images.unsplash.com/photo-1513519245088-0e12902e5a38?q=80&w=1000&auto=format&fit=crop",

  // --- Clothing & Textiles -------------------------------------------
  "workwear uniforms":
    "https://images.unsplash.com/photo-1607613009820-a29f7bb81c04?q=80&w=1000&auto=format&fit=crop",
  "everyday clothing":
    "https://images.unsplash.com/photo-1489987707025-afc232f7ea0f?q=80&w=1000&auto=format&fit=crop",
  "footwear":
    "https://images.unsplash.com/photo-1542291026-7eec264c27ff?q=80&w=1000&auto=format&fit=crop",
  "fabrics trims":
    "https://images.unsplash.com/photo-1767968037382-8eb9c564339f?q=80&w=1200&auto=format&fit=crop",

  // --- Beauty & Personal Care ----------------------------------------
  "skin hair care":
    "https://images.unsplash.com/photo-1556228720-195a672e8a03?q=80&w=1000&auto=format&fit=crop",
  "cosmetics":
    "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?q=80&w=1000&auto=format&fit=crop",
  "personal hygiene":
    "https://images.unsplash.com/photo-1786118791436-531a094afc3e?q=80&w=1200&auto=format&fit=crop",
  "salon spa supplies":
    "https://images.unsplash.com/photo-1560066984-138dadb4c035?q=80&w=1000&auto=format&fit=crop",

  // --- Sports & Outdoors ---------------------------------------------
  "fitness equipment":
    "https://images.unsplash.com/photo-1517838277536-f5f99be501cd?q=80&w=1000&auto=format&fit=crop",
  "team sports":
    "https://images.unsplash.com/photo-1517649763962-0c623266010b?q=80&w=1000&auto=format&fit=crop",
  "camping outdoor":
    "https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?q=80&w=1000&auto=format&fit=crop",
  "cycling":
    "https://images.unsplash.com/photo-1485965120184-e220f721d03e?q=80&w=1000&auto=format&fit=crop",

  // --- Toys, Hobbies & Crafts ----------------------------------------
  "toys games":
    "https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?q=80&w=1000&auto=format&fit=crop",
  "craft materials":
    "https://images.unsplash.com/photo-1680472483806-967e5fe520ad?q=80&w=1200&auto=format&fit=crop",
  "musical instruments":
    "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?q=80&w=1000&auto=format&fit=crop",
  "gifts party":
    "https://images.unsplash.com/photo-1513151233558-d860c5398176?q=80&w=1000&auto=format&fit=crop",

  // --- Books & Media -------------------------------------------------
  "books":
    "https://images.unsplash.com/photo-1765547683050-e215eda98103?q=80&w=1200&auto=format&fit=crop",
  "educational materials":
    "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?q=80&w=1000&auto=format&fit=crop",
  "audio video":
    "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?q=80&w=1000&auto=format&fit=crop",

  // --- Chemicals & Raw Materials -------------------------------------
  "industrial chemicals":
    "https://images.unsplash.com/photo-1784913108828-a7a36b9962e2?q=80&w=1200&auto=format&fit=crop",
  "plastics polymers":
    "https://images.unsplash.com/photo-1764835994645-3faa2c40f708?q=80&w=1200&auto=format&fit=crop",
  "metals alloys":
    "https://images.unsplash.com/photo-1504917599217-d4dc5ebe6122?q=80&w=1000&auto=format&fit=crop",
  "rubber sealing":
    "https://images.unsplash.com/photo-1615811361523-6bd03d7748e7?q=80&w=1000&auto=format&fit=crop",

  // --- Energy & Environment ------------------------------------------
  "solar renewables":
    "https://images.unsplash.com/photo-1509391365360-2e959784a276?q=80&w=1000&auto=format&fit=crop",
  "generators backup power":
    "https://images.unsplash.com/photo-1784913110019-fd310927b60b?q=80&w=1200&auto=format&fit=crop",
  "water treatment":
    "https://images.unsplash.com/photo-1784913110019-fd310927b60b?q=80&w=1200&auto=format&fit=crop",
  "air quality":
    "https://images.unsplash.com/photo-1784913110019-fd310927b60b?q=80&w=1200&auto=format&fit=crop",

});

/**
 * The form a key takes: lower case, and every run of punctuation or space
 * collapsed to one space.
 *
 * So "DC Flush Syringe(Swab Cap)", "dc flush syringe (swab cap)" and the slug
 * `dc-flush-syringe-swab-cap` all arrive at the same key, which matters
 * because the name comes from the operator's database and the slug comes from
 * the URL, and the two are typed by different people years apart.
 */
function flatten(value: string): string {
  return value
    .toLocaleLowerCase('en-GB')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The photograph for a sub-category, or `null` for the drawn plate.
 *
 * The slug is tried as a second chance for the reason `categoryCover` gives:
 * a deployment that has renamed a sub-category into its own language very
 * often still carries the original slug, and one extra lookup is cheaper than
 * a rail that lost its pictures at the first translation.
 */
export function subCategoryCover(name: string, slug: string): string | null {
  return COVERS[flatten(name)] ?? COVERS[flatten(slug)] ?? null;
}
