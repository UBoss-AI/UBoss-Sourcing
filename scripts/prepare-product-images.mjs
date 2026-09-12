/**
 * Turn the operator's product photography into web assets.
 *
 * The source photographs in `Images/` are the real thing — SPM's own product
 * shots, most of them captioned with the product name — at 4167 x 4167 and
 * 1.5 MB or more each. Thirty-nine megabytes of them cannot go near a
 * storefront, and nothing in the app displays one above about 900px, so this
 * resizes the ones the catalogue actually uses and writes them where the
 * importer can find them.
 *
 * ONE PHOTOGRAPH PER THING, NOT PER FILE
 *
 * The folder holds several shots of the same product — three of the safety
 * needle, three of the sterile-water syringe, two of the plain cannula. Only
 * one of each is carried, chosen for being the captioned or clearest shot, and
 * named after what it is rather than after its position in a folder. A file
 * called `Image-38.jpg` tells the next person nothing; `safety-needle.jpg`
 * tells them whether it is the right picture.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not decide which product gets which photograph. That is a claim
 * about a medical device — "this picture is of this thing" — and it lives in
 * `backend/src/modules/catalog/product-images/image-rules.ts` where it can be
 * read, reviewed and tested. This script only changes the pixels.
 *
 *   cd scripts && npm run images
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, '..', 'Images');
const TARGET = path.join(HERE, '..', 'backend', 'assets', 'product-images');

/**
 * The longest edge any screen asks for.
 *
 * The product page magnifies the hero under the pointer — see
 * `lib/pointer-zoom.ts` — so it genuinely reads more detail than it displays,
 * and 1200 is enough for that without carrying a print master into a web
 * request. The grid asks for 400.
 */
const EDGE = 1200;

/**
 * Which photograph is of what.
 *
 * The left-hand name is what the catalogue calls it and the right-hand file is
 * where it came from, so this table is also the record of which of the thirty
 * source shots was chosen and which were duplicates of it.
 */
const ASSETS = [
  // --- Intravenous access ---
  ['iv-cannula.jpg', 'Image-01.jpg', 'A plain IV cannula, captioned 18G to 24G. Also Image-33.'],
  ['iv-cannula-safety-winged.jpg', 'Image-39.jpg', 'Winged safety cannula, 14G to 26G. Also 16, 18.'],
  ['closed-iv-cannula.jpg', 'Image-14.jpg', 'Closed-system cannula with extension line.'],
  ['infusion-set.jpg', 'Image-21.jpg', 'An infusion set. Also Image-25, and 05/19 in amber.'],
  ['safety-needle.jpg', 'Image-38.jpg', 'Safety needles with the guard raised. Also 09, 35.'],

  // --- Prefilled syringes. Four products, four different fills. ---
  ['flush-syringe.jpg', 'Image-34.jpg', 'Saline flush syringes, captioned. Also Image-23.'],
  ['heparin-flush-syringe.jpg', 'Image-11.jpg', 'Heparin flush syringes, captioned. Carton: 30.'],
  ['citrate-flush-syringe.jpg', 'Image-02.jpg', 'Citra-Safe citrate flush syringes. Also 42.'],
  ['sterile-water-syringe.jpg', 'Image-27.jpg', 'Easy-Fill Aqua. Also 37; carton is 26.'],
  ['glycerine-syringe.jpg', 'Image-40.jpg', 'Easy-Fill with 10% glycerine. Also Image-17.'],

  // --- Blood gas ---
  ['abg-syringe.jpg', 'Image-43.jpg', 'Arterial blood gas syringes. Also Image-12.'],
  ['abg-sampling-kit.jpg', 'Image-29.jpg', 'Easy Blood-Collect sampling kit carton.'],

  // --- Plain syringes ---
  // Image-06 rather than Image-45: the two are the same shot and 45 is
  // mirrored, so its printed graduations read backwards.
  ['hypodermic-syringe.jpg', 'Image-06.jpg', 'Disposable syringes, 1 ml to 50 ml, captioned.'],
];

async function main() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`No source folder at ${SOURCE}`);
  }

  fs.mkdirSync(TARGET, { recursive: true });

  let written = 0;
  let bytes = 0;

  for (const [name, from, note] of ASSETS) {
    const input = path.join(SOURCE, from);
    if (!fs.existsSync(input)) {
      console.warn(`  MISSING  ${from} — skipping ${name}`);
      continue;
    }

    const output = path.join(TARGET, name);

    await sharp(input)
      // `contain` on white: every one of these is a product shot on white
      // already, so this pads rather than crops and nothing is cut off a
      // photograph that is wider than it is tall.
      .resize(EDGE, EDGE, { fit: 'contain', background: '#ffffff' })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, progressive: true, mozjpeg: true })
      .toFile(output);

    const size = fs.statSync(output).size;
    written += 1;
    bytes += size;
    console.log(`  ${name.padEnd(30)} ${String(Math.round(size / 1024)).padStart(5)} KB   ${note}`);
  }

  console.log('');
  console.log(`${String(written)} images, ${(bytes / 1048576).toFixed(1)} MB total, into`);
  console.log(`${TARGET}`);
  console.log('');
  console.log('Attach them to products with:  cd backend && npm run catalog:images');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
