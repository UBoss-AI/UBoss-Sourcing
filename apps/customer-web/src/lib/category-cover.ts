/**
 * Which photograph a department gets on the front page.
 *
 * The sibling of `lib/category-mark.ts`, and deliberately the same shape: a
 * list of name patterns, narrowest first, and the first one that matches wins.
 * Read that file's header for the reasoning behind matching on the NAME rather
 * than the slug, and for why the list is whole words — both apply here
 * unchanged, and for the same reason: two deployments slug "Tools & Hardware"
 * differently and name it the same.
 *
 * WHY A LOOKUP RATHER THAN A COLUMN
 *
 * A category in this product has no image. `CategoryNode` carries a name, a
 * slug and two counts, and adding a picture to it would mean every operator
 * uploading twenty-five photographs before their front page stopped looking
 * broken — on a product where a fresh deployment has to look finished with
 * nothing supplied. So the front page recognises the departments this
 * catalogue knows the names of and dresses those, and anything else gets the
 * drawn mark on a tinted plate that the department cards have always used.
 *
 * WHAT THAT MEANS FOR A DEPLOYMENT THAT IS NOT THIS ONE
 *
 * Nothing breaks. An operator who files their catalogue under names this file
 * has never seen gets a rail of drawn marks, which is what the grid before it
 * looked like — see `categoryCover` returning `null` and `CategoryPlate` in
 * `components/catalog/CategoryCarousel.tsx`. Nobody is shown a photograph of
 * something that is not what they sell, because a picture that is confidently
 * wrong about a department is worse than no picture at all. That rule is
 * written down in `components/icons.tsx` and it is why this list is short and
 * literal rather than a keyword guess.
 *
 * The photographs are hotlinked from Unsplash's CDN at a width the card
 * actually uses. They are decoration: every one of them sits behind a scrim
 * with the department's own name on top, the `<img>` is `aria-hidden`, and a
 * request that fails falls back to the same drawn plate an unrecognised
 * department gets. A deployment that cannot reach the CDN loses nothing but
 * the photograph.
 */

/**
 * The card is 336px wide at its largest and 224px on a phone, so 1200px covers
 * a 3x display with room to spare. The addresses these came from asked for
 * 2500px — about four times the bytes for pixels no screen in the rail can
 * show, on the first section below the fold of a landing page.
 */
const COVER_WIDTH = 1200;

function unsplash(photoId: string): string {
  return `https://images.unsplash.com/photo-${photoId}?q=80&w=${COVER_WIDTH}&auto=format&fit=crop`;
}

/**
 * Department name patterns, narrowest first.
 *
 * ORDER IS THE RULE, exactly as in `category-mark.ts`. "Electronics" has to be
 * tested before "Electrical" would claim it, "Food Service" before "Service",
 * and "Computers" before "Electronics" takes the IT department.
 *
 * Every entry is a deliberate statement that this photograph is right beside
 * this name. Adding one is cheap; adding one on a hunch is how a buyer of
 * laboratory glassware is shown a picture of a building site.
 */
const RECOGNISED: readonly [RegExp, string][] = [
  // --- health, laboratory, safety -------------------------------------
  [/\bmedical\b|\bhealthcare\b|\bclinical\b|\bsurgical\b|\bpatient\s*care\b/, unsplash('1584515979956-d9f6e5d09982')],
  [/\blaborator(y|ies)\b|\bscientific\b|\bdiagnostics?\b|\breagents?\b/, unsplash('1532187863486-abf9dbad1b69')],
  [/\bsafety\b|\bprotective\b|\bppe\b|\bhi[- ]?vis\b/, unsplash('1607613009820-a29f7bb81c04')],
  [/\bclean(ing|liness)?\b|\bhygiene\b|\bjanitorial\b|\bsanit(ary|ation)\b/, unsplash('1581578731548-c64695cc6952')],

  // --- industry, trade, materials -------------------------------------
  [/\bindustrial\b|\bmachinery\b|\bmanufacturing\b/, unsplash('1581091226825-a6a2a5aee158')],
  [/\btools?\b|\bhardware\b|\bfasteners?\b/, unsplash('1530124566582-a618bc2615dc')],
  [/\bbuilding\b|\bconstruction\b|\bmasonry\b|\bplumbing\b/, unsplash('1541888946425-d0fbb186a5b7')],
  [/\bchemicals?\b|\braw\s*materials?\b|\bsolvents?\b/, unsplash('1614935151651-0bea31271328')],
  [/\benergy\b|\benvironment(al)?\b|\bsolar\b|\brenewables?\b/, unsplash('1497435334941-8c899ee9e8e9')],

  // --- electrical and electronic, narrowest first ---------------------
  [/\bcomputers?\b|\b(it|ict)\b|\blaptops?\b|\bservers?\b|\bnetworking\b/, unsplash('1587831990711-23ca6441447b')],
  [/\bphones?\b|\bmobile\b|\bcommunications?\b|\btelecom\b/, unsplash('1511707171634-5f897ff02aa9')],
  [/\belectronics?\b|\bcomponents?\b|\bcircuits?\b|\bsemiconductors?\b/, unsplash('1518770660439-4636190af475')],
  [/\belectrical\b|\blighting\b|\bcabl(e|ing)\b|\bluminaires?\b/, unsplash('1550751827-4bd374c3f58b')],

  // --- workplace ------------------------------------------------------
  [/\boffice\b|\bstationer(y|ies)\b|\bpaper\b/, unsplash('1497215728101-856f4ea42174')],
  [/\bpackag(ing|e)\b|\bshipping\b|\bcartons?\b|\bpallets?\b/, unsplash('1586528116311-ad8dd3c8310d')],
  [/\bfurniture\b|\bfixtures?\b|\bseating\b|\bshelving\b/, unsplash('1555041469-a586c61ea9bc')],

  // --- transport, land, catering --------------------------------------
  [/\bautomotive\b|\bvehicles?\b|\btransport\b|\bspare\s*parts?\b/, unsplash('1486006920555-c77dce18193b')],
  [/\bagricultur(e|al)\b|\bgarden(ing)?\b|\bhorticultur(e|al)\b|\bfarm(ing)?\b/, unsplash('1416879595882-3373a0480b5b')],
  [/\bfood\s*service\b|\bcatering\b|\bhospitality\b|\bkitchenware\b/, unsplash('1555396273-367ea4eb4db5')],
  [/\bhome\b|\bkitchen\b|\bhousehold\b/, unsplash('1556911220-e15b29be8c8f')],

  // --- consumer -------------------------------------------------------
  [/\bcloth(ing|es)\b|\btextiles?\b|\buniforms?\b|\bworkwear\b|\bapparel\b/, unsplash('1489987707025-afc232f7ea0f')],
  [/\bbeauty\b|\bskincare\b|\bpersonal\s*care\b|\bcosmetics?\b/, unsplash('1522337360788-8b13dee7a37e')],
  [/\bsports?\b|\boutdoors?\b|\bfitness\b|\bcamping\b/, unsplash('1517649763962-0c623266010b')],
  [/\btoys?\b|\bhobb(y|ies)\b|\bcrafts?\b/, unsplash('1566576912321-d58ddd7a6088')],
  [/\bbooks?\b|\bmedia\b|\bliterature\b|\bpublications?\b/, unsplash('1495446815901-a7297e633e8d')],
];

/**
 * The photograph for a department, or `null` for the drawn plate.
 *
 * Matched case- and space-insensitively against the name, and against the slug
 * as a second chance — a deployment whose department is named in German still
 * slugs it in the operator's own words often enough to be worth the one extra
 * test, and a slug is hyphenated, so the separators are flattened first.
 */
export function categoryCover(name: string, slug: string): string | null {
  const haystacks = [name.toLowerCase(), slug.toLowerCase().replace(/[-_]+/g, ' ')];

  for (const [pattern, cover] of RECOGNISED) {
    if (haystacks.some((haystack) => pattern.test(haystack))) return cover;
  }

  return null;
}
