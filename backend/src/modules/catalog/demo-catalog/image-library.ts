/**
 * Photographs the demonstration catalogue is allowed to use without asking
 * anybody.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The preferred source is the Unsplash Search API, which finds a photograph
 * per PRODUCT - "cordless electric drill isolated" rather than "tools" - and
 * returns the photographer, the profile, the photo page and the download
 * endpoint the terms require to be pinged. That needs a key, and the ordinary
 * state of a freshly cloned repository is that it does not have one.
 *
 * The wrong answers to that are both tempting. Inventing photo IDs produces a
 * catalogue of broken images and a file of URLs nobody can verify. Giving four
 * hundred products the same grey placeholder produces a storefront that
 * demonstrates nothing. So this is the third answer: every URL below is one
 * the storefront ALREADY ships and already renders - they are lifted from
 * `apps/customer-web/src/lib/subcategory-cover.ts` and `category-cover.ts`,
 * where they dress the category rails - plus the department set the operator
 * supplied. Nothing here was made up.
 *
 * WHAT A SHELF GETS
 *
 * An ordered list, most specific first. The first product on a shelf gets the
 * photograph of that exact shelf; the second and third get neighbours chosen
 * to be the same kind of thing without being the same picture, because three
 * cards in a row carrying one image is the single clearest tell that a
 * catalogue was generated. Where a shelf has fewer entries than it has
 * products, the list wraps - and the product that wrapped is marked
 * `imageNeedsReview`, so the seed's report says exactly which photographs a
 * person should look at rather than quietly implying all of them were chosen.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * A photograph of a person using something unrelated, a factory floor standing
 * in for one bearing, a smartphone standing in for a router. An image that
 * does not show the product type is worse than no image: the placeholder says
 * "we have not photographed this", and a wrong photograph says something
 * false. Where this file has nothing honest to offer, it says so and the
 * caller falls back to the placeholder.
 */

/**
 * One hotlinked Unsplash URL, sized for a product card.
 *
 * Square, because the storefront's media frame is `aspect-square` and a
 * landscape photograph letterboxed into it wastes a third of the card.
 * `auto=format` lets the CDN serve AVIF or WebP to browsers that take them,
 * `crop=entropy` keeps the subject rather than the middle, and 1200px is the
 * gallery size - the card asks for 400 and the browser downsamples, which
 * costs bandwidth and buys a picture that is still sharp on a retina screen
 * when somebody opens the gallery.
 *
 * Hotlinked rather than downloaded, which is what the Unsplash API terms ask
 * for: the URL a photo's `urls` field returns is the URL that should be used.
 */
function u(photoId: string): string {
  return `https://images.unsplash.com/photo-${photoId}?auto=format&fit=crop&crop=entropy&w=1200&h=1200&q=80`;
}

/**
 * A photograph on somebody else's own web site.
 *
 * A handful of the medical shelves are dressed this way in the storefront
 * already, because Unsplash has no photograph of an ENFit syringe and a
 * generic laboratory scene would be a lie. These hosts are not built to be
 * hotlinked: they may add hotlink protection, move the file or go away, and
 * the day one of them does, that card falls back to the placeholder with no
 * other consequence. That is the trade, it is deliberate, and it is why
 * everything sourced this way is marked for review.
 */
function external(url: string): string {
  return url;
}

/**
 * The department photograph, for a product whose shelf has run out of its own.
 *
 * Supplied by the operator and specific to the department rather than to the
 * product - which is exactly why anything falling back this far is marked
 * `imageNeedsReview`. It is a good-looking card and an unverified claim about
 * what is in the box.
 */
export const DEPARTMENT_IMAGES: Readonly<Record<string, string>> = Object.freeze({
  'medical-devices': u('1584308666744-24d5c474f2ae'),
  'laboratory-scientific': u('1582719508461-905c673771fd'),
  'industrial-supplies': u('1504328345606-18bbc8c9d7d1'),
  'tools-hardware': u('1504148455328-c376907d081c'),
  'electrical-lighting': u('1513506003901-1e6a229e2d15'),
  'electronics-components': u('1518770660439-4636190af475'),
  'computers-it': u('1496181133206-80ce9b88a853'),
  'phones-communication': u('1511707171634-5f897ff02aa9'),
  'office-stationery': u('1583485088034-697b5bc54ccd'),
  'packaging-shipping': u('1589939705384-5185137a7f0f'),
  'safety-protective-equipment': u('1584467735871-8e85353a8413'),
  'cleaning-hygiene': u('1585421514738-01798e348b17'),
  'building-construction': u('1541888946425-d0fbb186a5b7'),
  'automotive-transport': u('1611821064430-0d40291d0f0b'),
  'agriculture-gardening': u('1416879595882-3373a0480b5b'),
  'food-service-catering': u('1583778176476-4a8b02a64c01'),
  'furniture-fixtures': u('1567538096630-e0c55bd6374c'),
  'home-kitchen': u('1584992236310-6edddc08acff'),
  'clothing-textiles': u('1521572267360-ee0c2909d518'),
  'beauty-personal-care': u('1608248597261-833258657640'),
  'sports-outdoors': u('1602143407151-7111542de6e8'),
  'toys-hobbies-crafts': u('1587654780291-39c9404d746b'),
  'books-media': u('1544716278-ca5e3f4abd8c'),
  'chemicals-raw-materials': u('1614935151651-0bea31271328'),
  'energy-environment': u('1508514177221-188b1cf16e9d'),
});

/**
 * Photographs per sub-category, most specific first.
 *
 * Keyed on `categories.slug`, never on a display name: the name is the
 * operator's to change and one of them will rename "Footwear" to "Shoes &
 * Boots" on their second day. The slugs here are the ones the starter
 * catalogue plants and the ones the supplier import created for the medical
 * department, spelling included - `oral-syiringe` is misspelt in the database
 * and correcting it here would simply mean no match.
 */
export const SUBCATEGORY_IMAGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // --- Medical Devices -------------------------------------------------
  //
  // Unsplash has photographs of clinicians and of hospital rooms; it does not
  // have a photograph of a 20-gauge closed IV cannula. So these are the
  // supplier photographs the storefront already uses, and everything on this
  // department is marked for review by the resolver rather than presented as
  // a chosen image.
  'abg-kit': [
    external('https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'abg-syringe': [
    external('https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'adult-diaper': [
    external('https://cdn.shopify.com/s/files/1/0625/3402/5474/files/1_deeef9d4-ffdd-4d3e-9cae-18947c579005_400x.jpg?v=1760174433'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'closed-iv-cannula': [
    external('https://d2t0svjwo1hj60.cloudfront.net/media/public/b9d6a2bdbc154d059_image.png'),
    u('1584515933487-779824d29309'),
  ],
  'dc-flush-syringe-swab-cap': [
    external('https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48'),
    u('1584515933487-779824d29309'),
  ],
  'disinfectant-cap': [
    external('https://d2t0svjwo1hj60.cloudfront.net/media/public/b9d6a2bdbc154d059_image.png'),
    u('1584515933487-779824d29309'),
  ],
  'enfit-syringe': [
    external('https://ukmedi.co.uk/cdn/shop/files/medicina-60ml-enfit-medicina-syringe-lpe60-ukmedi-uk-medical-supplies__39347_1657086920_1280_1280.jpg?v=1728563002&width=1445'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'flush-syringe': [
    external('https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'infant-feeding-tube': [
    external('https://oralkart.com/cdn/shop/files/Romsons_Infant_Feeding_Tube_with_Graduated_Scale_FEEDY_GS-4038.webp?v=1752136773'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'infusion-set': [
    external('https://www.zrmed.com/uploads/2012/iv-infusion-set-manufacturer.jpg'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'insulin-syringe': [
    external('https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48'),
    u('1584515933487-779824d29309'),
  ],
  'iv-cannula': [
    external('https://d2t0svjwo1hj60.cloudfront.net/media/public/b9d6a2bdbc154d059_image.png'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'line-access': [
    external('https://d2t0svjwo1hj60.cloudfront.net/media/public/b9d6a2bdbc154d059_image.png'),
    u('1584515933487-779824d29309'),
  ],
  'line-conditioning': [
    external('https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48'),
    u('1584515933487-779824d29309'),
  ],
  'iv-administration-sets': [
    external('https://www.zrmed.com/uploads/2012/iv-infusion-set-manufacturer.jpg'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'oral-dosing-syringe': [
    external('https://www.rehabmart.com/imagesfromrd/Purple~3.jpg'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'oral-syiringe': [
    external('https://www.rehabmart.com/imagesfromrd/Purple~3.jpg'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'prefilled-heparin-syringe': [
    external('https://www.mountainside-medical.com/cdn/shop/files/Heparin-Sodium-Injection-Prefilled-Syringes-5000-Units-Per-1-mL-by-Hikma_1200x1200.jpg?v=1713447273'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'ryles-tube': [
    external('https://oralkart.com/cdn/shop/files/Romsons_Infant_Feeding_Tube_with_Graduated_Scale_FEEDY_GS-4038.webp?v=1752136773'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'safety-needle': [
    external('https://www.mountainside-medical.com/cdn/shop/files/Heparin-Sodium-Injection-Prefilled-Syringes-5000-Units-Per-1-mL-by-Hikma_1200x1200.jpg?v=1713447273'),
    u('1584515933487-779824d29309'),
  ],
  'sodium-citrate-prefilled-syringe': [
    external('https://www.medixgroup.co.uk/web/image/product.template/907/image_1024?unique=6c72d48'),
    u('1584515933487-779824d29309'),
  ],
  'sterile-water': [
    external('https://mentorsolutions.ca/cdn/shop/files/IMG-3579.jpg?v=1759955342&width=2048'),
    u('1584515933487-779824d29309'),
  ],
  'sterile-water-with-10-glycerine': [
    external('https://mentorsolutions.ca/cdn/shop/files/IMG-3579.jpg?v=1759955342&width=2048'),
    u('1584515933487-779824d29309'),
  ],
  'suction-catheter': [
    external('https://www.gpmedline.com/cdn/shop/files/1SC12-Suction_Catheter_With_Thumb_Control_Size_12.webp?v=1725943369&width=1445'),
    u('1584308666744-24d5c474f2ae'),
  ],
  'surgical-gloves': [
    external('https://thehospitalwarehouse.com/cdn/shop/files/box-of-sterile-surgical-gloves_1533x1022.png?v=1760695177'),
    u('1584515933487-779824d29309'),
  ],
  syringes: [
    external('https://www.mountainside-medical.com/cdn/shop/files/Heparin-Sodium-Injection-Prefilled-Syringes-5000-Units-Per-1-mL-by-Hikma_1200x1200.jpg?v=1713447273'),
    u('1584308666744-24d5c474f2ae'),
  ],

  // --- Laboratory & Scientific -----------------------------------------
  'lab-instruments': [
    u('1614308460927-5024ba2e1dcb'),
    u('1582719508461-905c673771fd'),
    u('1581092335397-9583fe92d232'),
  ],
  'lab-glassware-plasticware': [
    u('1532187863486-abf9dbad1b69'),
    u('1614935151651-0bea31271328'),
    u('1579154204601-01588f351e67'),
  ],
  'lab-reagents-chemicals': [
    u('1614935151651-0bea31271328'),
    u('1784913108828-a7a36b9962e2'),
    u('1532187863486-abf9dbad1b69'),
  ],
  'lab-consumables-sampling': [
    u('1579154204601-01588f351e67'),
    u('1532187863486-abf9dbad1b69'),
    u('1614308460927-5024ba2e1dcb'),
  ],
  'measurement-calibration': [
    u('1581092335397-9583fe92d232'),
    u('1614308460927-5024ba2e1dcb'),
    u('1581092160607-ee22621dd758'),
  ],

  // --- Industrial Supplies ---------------------------------------------
  'fasteners-fixings': [
    u('1608613304899-2821217e2f5b'),
    u('1530124566582-a618bc2615dc'),
    u('1581147036324-c17ac41dfa6c'),
  ],
  'bearings-power-transmission': [
    u('1504917599217-d4dc5ebe6122'),
    u('1581091226825-a6a2a5aee158'),
    u('1581092160607-ee22621dd758'),
  ],
  'hydraulics-pneumatics': [
    u('1581092335397-9583fe92d232'),
    u('1581092160607-ee22621dd758'),
    u('1581091226825-a6a2a5aee158'),
  ],
  'pumps-valves': [
    u('1581092160607-ee22621dd758'),
    u('1585704032915-c3400ca199e7'),
    u('1581091226825-a6a2a5aee158'),
  ],
  abrasives: [
    u('1504307651254-35680f356dfd'),
    u('1530124566582-a618bc2615dc'),
    u('1581147036324-c17ac41dfa6c'),
  ],
  'lubricants-adhesives': [
    u('1615811361523-6bd03d7748e7'),
    u('1784913108828-a7a36b9962e2'),
    u('1607860108855-64acf2078ed9'),
  ],
  'welding-soldering': [
    u('1504307651254-35680f356dfd'),
    u('1581091226825-a6a2a5aee158'),
    u('1530124566582-a618bc2615dc'),
  ],
  'material-handling': [
    u('1586528116311-ad8dd3c8310d'),
    u('1769355104335-acef3aa4c9b6'),
    u('1581091226825-a6a2a5aee158'),
  ],

  // --- Tools & Hardware -------------------------------------------------
  'hand-tools': [
    u('1581147036324-c17ac41dfa6c'),
    u('1530124566582-a618bc2615dc'),
    u('1586864387967-d02ef85d93e8'),
  ],
  'power-tools': [
    u('1504148455328-c376907d081c'),
    u('1581147036324-c17ac41dfa6c'),
    u('1586864387967-d02ef85d93e8'),
  ],
  'cutting-tools': [
    u('1530124566582-a618bc2615dc'),
    u('1504307651254-35680f356dfd'),
    u('1581147036324-c17ac41dfa6c'),
  ],
  'measuring-layout': [
    u('1581092160607-ee22621dd758'),
    u('1581092335397-9583fe92d232'),
    u('1581147036324-c17ac41dfa6c'),
  ],
  'tool-storage': [
    u('1586864387967-d02ef85d93e8'),
    u('1595428774223-ef52624120d2'),
    u('1581147036324-c17ac41dfa6c'),
  ],

  // --- Electrical & Lighting -------------------------------------------
  'cables-wiring': [
    u('1767514536570-83d70c024247'),
    u('1550751827-4bd374c3f58b'),
    u('1697071327741-04319e5d54d3'),
  ],
  'switches-sockets': [
    u('1550751827-4bd374c3f58b'),
    u('1767514536570-83d70c024247'),
    u('1513506003901-1e6a229e2d15'),
  ],
  'circuit-protection': [
    u('1767514536570-83d70c024247'),
    u('1697071327741-04319e5d54d3'),
    u('1550751827-4bd374c3f58b'),
  ],
  'motors-drives': [
    u('1581092160607-ee22621dd758'),
    u('1581091226825-a6a2a5aee158'),
    u('1504917599217-d4dc5ebe6122'),
  ],
  lighting: [
    u('1507473885765-e6ed057f782c'),
    u('1513506003901-1e6a229e2d15'),
    u('1550751827-4bd374c3f58b'),
  ],
  'batteries-power-supplies': [
    u('1619725002198-6a689b72f41d'),
    u('1697071327741-04319e5d54d3'),
    u('1518770660439-4636190af475'),
  ],

  // --- Electronics & Components ----------------------------------------
  'electronic-components': [
    u('1518770660439-4636190af475'),
    u('1697071327741-04319e5d54d3'),
    u('1517077304055-6e89abbf09b0'),
  ],
  'sensors-automation': [
    u('1517077304055-6e89abbf09b0'),
    u('1518770660439-4636190af475'),
    u('1581092335397-9583fe92d232'),
  ],
  'test-measurement': [
    u('1581092335397-9583fe92d232'),
    u('1518770660439-4636190af475'),
    u('1614308460927-5024ba2e1dcb'),
  ],
  'enclosures-connectors': [
    u('1697071327741-04319e5d54d3'),
    u('1518770660439-4636190af475'),
    u('1767514536570-83d70c024247'),
  ],

  // --- Computers & IT ---------------------------------------------------
  'laptops-desktops': [
    u('1496181133206-80ce9b88a853'),
    u('1587831990711-23ca6441447b'),
    u('1527864550417-7fd91fc51a46'),
  ],
  'computer-peripherals': [
    u('1527864550417-7fd91fc51a46'),
    u('1496181133206-80ce9b88a853'),
    u('1587831990711-23ca6441447b'),
  ],
  networking: [
    u('1544197150-b99a580bb7a8'),
    u('1587831990711-23ca6441447b'),
    u('1697071327741-04319e5d54d3'),
  ],
  'storage-media': [
    u('1597872200969-2b65d56bd16b'),
    u('1587831990711-23ca6441447b'),
    u('1518770660439-4636190af475'),
  ],
  'printers-scanners': [
    u('1612815154858-60aa4c59eaa6'),
    u('1497215728101-856f4ea42174'),
    u('1587831990711-23ca6441447b'),
  ],
  'software-licences': [
    u('1555066931-4365d14bab8c'),
    u('1496181133206-80ce9b88a853'),
    u('1587831990711-23ca6441447b'),
  ],

  // --- Phones & Communication -------------------------------------------
  'mobile-phones': [
    u('1511707171634-5f897ff02aa9'),
    u('1583394838336-acd977736f90'),
    u('1496181133206-80ce9b88a853'),
  ],
  'phone-accessories': [
    u('1583394838336-acd977736f90'),
    u('1619725002198-6a689b72f41d'),
    u('1511707171634-5f897ff02aa9'),
  ],
  'two-way-radios': [
    u('1520923642038-b4259acecbd7'),
    u('1511707171634-5f897ff02aa9'),
    u('1517077304055-6e89abbf09b0'),
  ],
  telephony: [
    u('1520923642038-b4259acecbd7'),
    u('1544197150-b99a580bb7a8'),
    u('1497215728101-856f4ea42174'),
  ],

  // --- Office & Stationery ----------------------------------------------
  'paper-notebooks': [
    u('1517842645767-c639042777db'),
    u('1583485088034-697b5bc54ccd'),
    u('1586281380349-632531db7ed4'),
  ],
  'writing-correction': [
    u('1585336261026-61e778f29280'),
    u('1583485088034-697b5bc54ccd'),
    u('1517842645767-c639042777db'),
  ],
  'filing-organisation': [
    u('1586281380349-632531db7ed4'),
    u('1497215728101-856f4ea42174'),
    u('1595428774223-ef52624120d2'),
  ],
  'office-machines': [
    u('1612815154858-60aa4c59eaa6'),
    u('1497215728101-856f4ea42174'),
    u('1586281380349-632531db7ed4'),
  ],
  'printer-supplies': [
    u('1612815154858-60aa4c59eaa6'),
    u('1586281380349-632531db7ed4'),
    u('1497215728101-856f4ea42174'),
  ],

  // --- Packaging & Shipping ---------------------------------------------
  'boxes-cartons': [
    u('1769355104335-acef3aa4c9b6'),
    u('1586528116311-ad8dd3c8310d'),
    u('1589939705384-5185137a7f0f'),
  ],
  'tapes-strapping': [
    u('1589939705384-5185137a7f0f'),
    u('1769355104335-acef3aa4c9b6'),
    u('1607166452427-7e4477079cb9'),
  ],
  'protective-packaging': [
    u('1607166452427-7e4477079cb9'),
    u('1769355104335-acef3aa4c9b6'),
    u('1586528116311-ad8dd3c8310d'),
  ],
  'bags-films': [
    u('1769355104335-acef3aa4c9b6'),
    u('1607166452427-7e4477079cb9'),
    u('1589939705384-5185137a7f0f'),
  ],
  'labels-marking': [
    u('1586281380349-632531db7ed4'),
    u('1769355104335-acef3aa4c9b6'),
    u('1612815154858-60aa4c59eaa6'),
  ],

  // --- Safety & Protective Equipment ------------------------------------
  'hand-protection': [
    external('https://thehospitalwarehouse.com/cdn/shop/files/box-of-sterile-surgical-gloves_1533x1022.png?v=1760695177'),
    u('1607613009820-a29f7bb81c04'),
    u('1584467735871-8e85353a8413'),
  ],
  'eye-face-protection': [
    u('1584017911766-d451b3d0e843'),
    u('1584467735871-8e85353a8413'),
    u('1607613009820-a29f7bb81c04'),
  ],
  'respiratory-protection': [
    u('1584634731339-252c581abfc5'),
    u('1584467735871-8e85353a8413'),
    u('1607613009820-a29f7bb81c04'),
  ],
  'head-fall-protection': [
    u('1788883439454-81b23fe50588'),
    u('1504328345606-18bbc8c9d7d1'),
    u('1607613009820-a29f7bb81c04'),
  ],
  'protective-clothing': [
    u('1607613009820-a29f7bb81c04'),
    u('1788883439454-81b23fe50588'),
    u('1504328345606-18bbc8c9d7d1'),
  ],
  /*
   * No photograph of a boot, deliberately.
   *
   * The obvious candidate in this library - `1542291026-7eec264c27ff`, which
   * the storefront's own category rail uses - is a running shoe with a large
   * maker's mark across the side. On a category tile that is a picture of
   * "footwear"; on a PRODUCT card it is somebody else's trade mark sitting
   * over our own brand name and our own price, which is the one thing a
   * catalogue must not print.
   *
   * So these two shelves fall back to protective-equipment photographs, and
   * the resolver marks every product on them for review. A card that is
   * honestly approximate beats one that is misleading and pretty.
   */
  'safety-footwear': [
    u('1607613009820-a29f7bb81c04'),
    u('1504328345606-18bbc8c9d7d1'),
    u('1788883439454-81b23fe50588'),
  ],
  'fire-safety-first-aid': [
    u('1603398938378-e54eab446dde'),
    u('1584467735871-8e85353a8413'),
    u('1607613009820-a29f7bb81c04'),
  ],

  // --- Cleaning & Hygiene ------------------------------------------------
  'cleaning-chemicals': [
    u('1585421514284-efb74c2b69ba'),
    u('1585421514738-01798e348b17'),
    u('1581578731548-c64695cc6952'),
  ],
  'disinfection-sterilisation': [
    u('1584515933487-779824d29309'),
    u('1585421514284-efb74c2b69ba'),
    u('1585421514738-01798e348b17'),
  ],
  'cleaning-equipment': [
    u('1581578731548-c64695cc6952'),
    u('1585421514738-01798e348b17'),
    u('1532996122724-e3c354a0b15b'),
  ],
  'washroom-supplies': [
    u('1759846866217-e627e4478f82'),
    u('1581578731548-c64695cc6952'),
    u('1585421514738-01798e348b17'),
  ],
  'waste-management': [
    u('1532996122724-e3c354a0b15b'),
    u('1581578731548-c64695cc6952'),
    u('1769355104335-acef3aa4c9b6'),
  ],

  // --- Building & Construction -------------------------------------------
  'building-materials': [
    u('1775049525141-783d72f14ca1'),
    u('1541888946425-d0fbb186a5b7'),
    u('1504328345606-18bbc8c9d7d1'),
  ],
  'plumbing-sanitary': [
    u('1585704032915-c3400ca199e7'),
    u('1581092160607-ee22621dd758'),
    u('1541888946425-d0fbb186a5b7'),
  ],
  'heating-ventilation-cooling': [
    u('1621905251189-08b45d6a269e'),
    u('1584269600464-37b1b58a9fe7'),
    u('1541888946425-d0fbb186a5b7'),
  ],
  'paint-surface-finishing': [
    u('1562259949-e8e7689d7828'),
    u('1541888946425-d0fbb186a5b7'),
    u('1775049525141-783d72f14ca1'),
  ],
  'doors-windows-ironmongery': [
    u('1513694203232-719a280e022f'),
    u('1541888946425-d0fbb186a5b7'),
    u('1775049525141-783d72f14ca1'),
  ],

  // --- Automotive & Transport ---------------------------------------------
  'vehicle-parts': [
    u('1783427401156-aaf899c76ecb'),
    u('1486006920555-c77dce18193b'),
    u('1530046339160-ce3e530c7d2f'),
  ],
  'tyres-wheels': [
    u('1578844251758-2f71da64c96f'),
    u('1611821064430-0d40291d0f0b'),
    u('1486006920555-c77dce18193b'),
  ],
  'garage-equipment': [
    u('1530046339160-ce3e530c7d2f'),
    u('1486006920555-c77dce18193b'),
    u('1581091226825-a6a2a5aee158'),
  ],
  'vehicle-care': [
    u('1607860108855-64acf2078ed9'),
    u('1530046339160-ce3e530c7d2f'),
    u('1585421514284-efb74c2b69ba'),
  ],

  // --- Agriculture & Gardening --------------------------------------------
  'farm-equipment': [
    u('1500937386664-56d1dfef3854'),
    u('1416879595882-3373a0480b5b'),
    u('1763844597656-eddb0836065f'),
  ],
  irrigation: [
    u('1563514227147-6d2ff665a6a0'),
    u('1500937386664-56d1dfef3854'),
    u('1585704032915-c3400ca199e7'),
  ],
  'seeds-feed-fertiliser': [
    u('1416879595882-3373a0480b5b'),
    u('1500937386664-56d1dfef3854'),
    u('1563514227147-6d2ff665a6a0'),
  ],
  'garden-tools-outdoor': [
    u('1763844597656-eddb0836065f'),
    u('1416879595882-3373a0480b5b'),
    u('1581147036324-c17ac41dfa6c'),
  ],

  // --- Food Service & Catering ---------------------------------------------
  'commercial-kitchen-equipment': [
    u('1778837224430-bc0f32c27f53'),
    u('1583778176476-4a8b02a64c01'),
    u('1555396273-367ea4eb4db5'),
  ],
  'tableware-serving': [
    u('1578749556568-bc2c40e68b61'),
    u('1555396273-367ea4eb4db5'),
    u('1777499455332-ec8800b7c197'),
  ],
  'disposables-takeaway': [
    u('1586528116311-ad8dd3c8310d'),
    u('1769355104335-acef3aa4c9b6'),
    u('1555396273-367ea4eb4db5'),
  ],
  'food-storage-refrigeration': [
    u('1584269600464-37b1b58a9fe7'),
    u('1778837224430-bc0f32c27f53'),
    u('1621905251189-08b45d6a269e'),
  ],

  // --- Furniture & Fixtures -------------------------------------------------
  'office-furniture': [
    u('1497215728101-856f4ea42174'),
    u('1555041469-a586c61ea9bc'),
    u('1567538096630-e0c55bd6374c'),
  ],
  seating: [
    u('1580481072645-022f9a6d8310'),
    u('1567538096630-e0c55bd6374c'),
    u('1555041469-a586c61ea9bc'),
  ],
  'storage-shelving': [
    u('1595428774223-ef52624120d2'),
    u('1555041469-a586c61ea9bc'),
    u('1586864387967-d02ef85d93e8'),
  ],
  'retail-display': [
    u('1441986300917-64674bd600d8'),
    u('1595428774223-ef52624120d2'),
    u('1555041469-a586c61ea9bc'),
  ],

  // --- Home & Kitchen --------------------------------------------------------
  kitchenware: [
    u('1777499455332-ec8800b7c197'),
    u('1584992236310-6edddc08acff'),
    u('1578749556568-bc2c40e68b61'),
  ],
  'home-appliances': [
    u('1584269600464-37b1b58a9fe7'),
    u('1556911220-e15b29be8c8f'),
    u('1621905251189-08b45d6a269e'),
  ],
  'bedding-bath': [
    u('1616627781431-23b776ada33d'),
    u('1513519245088-0e12902e5a38'),
    u('1767968037382-8eb9c564339f'),
  ],
  'home-decor': [
    u('1513519245088-0e12902e5a38'),
    u('1556911220-e15b29be8c8f'),
    u('1567538096630-e0c55bd6374c'),
  ],

  // --- Clothing & Textiles ----------------------------------------------------
  'workwear-uniforms': [
    u('1607613009820-a29f7bb81c04'),
    u('1521572267360-ee0c2909d518'),
    u('1788883439454-81b23fe50588'),
  ],
  'everyday-clothing': [
    u('1489987707025-afc232f7ea0f'),
    u('1521572267360-ee0c2909d518'),
    u('1515886657613-9f3515b0c78f'),
  ],
  /** Same reason as `safety-footwear` above: no branded shoe on a product card. */
  footwear: [
    u('1489987707025-afc232f7ea0f'),
    u('1521572267360-ee0c2909d518'),
    u('1515886657613-9f3515b0c78f'),
  ],
  'fabrics-trims': [
    u('1767968037382-8eb9c564339f'),
    u('1521572267360-ee0c2909d518'),
    u('1616627781431-23b776ada33d'),
  ],

  // --- Beauty & Personal Care ---------------------------------------------------
  'skin-hair-care': [
    u('1556228720-195a672e8a03'),
    u('1608248597261-833258657640'),
    u('1560066984-138dadb4c035'),
  ],
  cosmetics: [
    u('1522337360788-8b13dee7a37e'),
    u('1608248597261-833258657640'),
    u('1556228720-195a672e8a03'),
  ],
  'personal-hygiene': [
    u('1786118791436-531a094afc3e'),
    u('1759846866217-e627e4478f82'),
    u('1556228720-195a672e8a03'),
  ],
  'salon-spa-supplies': [
    u('1560066984-138dadb4c035'),
    u('1522337360788-8b13dee7a37e'),
    u('1608248597261-833258657640'),
  ],

  // --- Sports & Outdoors ----------------------------------------------------------
  'fitness-equipment': [
    u('1517838277536-f5f99be501cd'),
    u('1602143407151-7111542de6e8'),
    u('1517649763962-0c623266010b'),
  ],
  'team-sports': [
    u('1517649763962-0c623266010b'),
    u('1517838277536-f5f99be501cd'),
    u('1602143407151-7111542de6e8'),
  ],
  'camping-outdoor': [
    u('1504280390367-361c6d9f38f4'),
    u('1602143407151-7111542de6e8'),
    u('1517649763962-0c623266010b'),
  ],
  cycling: [
    u('1485965120184-e220f721d03e'),
    u('1517838277536-f5f99be501cd'),
    u('1504280390367-361c6d9f38f4'),
  ],

  // --- Toys, Hobbies & Crafts ------------------------------------------------------
  'toys-games': [
    u('1566576912321-d58ddd7a6088'),
    u('1587654780291-39c9404d746b'),
    u('1513151233558-d860c5398176'),
  ],
  'craft-materials': [
    u('1680472483806-967e5fe520ad'),
    u('1587654780291-39c9404d746b'),
    u('1767968037382-8eb9c564339f'),
  ],
  'musical-instruments': [
    u('1511671782779-c97d3d27a1d4'),
    u('1566576912321-d58ddd7a6088'),
    u('1587654780291-39c9404d746b'),
  ],
  'gifts-party': [
    u('1513151233558-d860c5398176'),
    u('1587654780291-39c9404d746b'),
    u('1566576912321-d58ddd7a6088'),
  ],

  // --- Books & Media ------------------------------------------------------------------
  books: [
    u('1765547683050-e215eda98103'),
    u('1544716278-ca5e3f4abd8c'),
    u('1495446815901-a7297e633e8d'),
  ],
  'educational-materials': [
    u('1503676260728-1c00da094a0b'),
    u('1544716278-ca5e3f4abd8c'),
    u('1765547683050-e215eda98103'),
  ],
  'audio-video': [
    u('1511671782779-c97d3d27a1d4'),
    u('1495446815901-a7297e633e8d'),
    u('1527864550417-7fd91fc51a46'),
  ],

  // --- Chemicals & Raw Materials ---------------------------------------------------------
  'industrial-chemicals': [
    u('1784913108828-a7a36b9962e2'),
    u('1614935151651-0bea31271328'),
    u('1532187863486-abf9dbad1b69'),
  ],
  'plastics-polymers': [
    u('1764835994645-3faa2c40f708'),
    u('1784913108828-a7a36b9962e2'),
    u('1769355104335-acef3aa4c9b6'),
  ],
  'metals-alloys': [
    u('1504917599217-d4dc5ebe6122'),
    u('1775049525141-783d72f14ca1'),
    u('1581091226825-a6a2a5aee158'),
  ],
  'rubber-sealing': [
    u('1615811361523-6bd03d7748e7'),
    u('1764835994645-3faa2c40f708'),
    u('1504917599217-d4dc5ebe6122'),
  ],

  // --- Energy & Environment -----------------------------------------------------------------
  'solar-renewables': [
    u('1509391365360-2e959784a276'),
    u('1508514177221-188b1cf16e9d'),
    u('1497435334941-8c899ee9e8e9'),
  ],
  'generators-backup-power': [
    u('1784913110019-fd310927b60b'),
    u('1581091226825-a6a2a5aee158'),
    u('1619725002198-6a689b72f41d'),
  ],
  'water-treatment': [
    u('1784913110019-fd310927b60b'),
    u('1585704032915-c3400ca199e7'),
    u('1563514227147-6d2ff665a6a0'),
  ],
  'air-quality': [
    u('1784913110019-fd310927b60b'),
    u('1621905251189-08b45d6a269e'),
    u('1517077304055-6e89abbf09b0'),
  ],
});

/**
 * Sub-categories whose photographs are department-level stand-ins rather than
 * pictures of the product.
 *
 * Medical Devices, all of it. Unsplash has a great many photographs of
 * clinicians and hospital corridors and not one of a 20-gauge closed IV
 * cannula, so every shelf in that department is dressed with a supplier's own
 * photograph of something in the right family - which is honest enough to
 * publish and not honest enough to call chosen. Everything here comes back
 * with `imageNeedsReview` set, and appears on the seed's review report.
 */
export const REVIEW_REQUIRED_DEPARTMENTS: ReadonlySet<string> = new Set(['medical-devices']);

/**
 * Shelves whose photographs are of the right FAMILY but not of the product.
 *
 * Narrower than a whole department and for a different reason: these are
 * shelves where the obvious photograph carries a third-party maker's mark, and
 * a brand-free one that actually shows the product does not exist in this
 * library. Protective equipment stands in for a safety boot; a rail of clothes
 * stands in for a shoe. Both are honest about the trade and say nothing false
 * about the item, and both are on the review report so a person with a real
 * photograph knows exactly which cards to replace.
 */
export const REVIEW_REQUIRED_SUBCATEGORIES: ReadonlySet<string> = new Set([
  'safety-footwear',
  'footwear',
]);
