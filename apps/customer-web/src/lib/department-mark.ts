/**
 * Which mark a department gets in the category strip.
 *
 * The third member of a family: `lib/category-mark.ts` picks a shelf icon,
 * `lib/category-cover.ts` picks a photograph, and this picks the strip's
 * two-tone department mark. All three are the same shape — a list of name
 * patterns, narrowest first, first match wins — and the reasoning in
 * `category-mark.ts`'s header applies here unchanged: matching is on the NAME
 * because two deployments slug "Tools & Hardware" differently and name it the
 * same, and the patterns are whole words because a rule that matched "tool"
 * anywhere would also claim "Tooling Fluids", which is a lubricant.
 *
 * WHY THIS IS NOT `categoryMark`
 *
 * `categoryMark` answers "what is in this box?" and its recognised set is
 * shelf-level: a cannula, a Ryles tube, an ENFit syringe. Ask it about
 * "Medical Devices" and it matches nothing recognisable and falls through to
 * an abstract hexagon — correct for a card that has a name beside it, useless
 * for a strip where the mark is most of what a shopper sees.
 *
 * So this file recognises the DEPARTMENT names — the twenty-five headings the
 * starter catalogue is filed under — and nothing below them. The two sets do
 * not overlap and neither has to know about the other.
 *
 * WHAT A DEPLOYMENT THAT IS NOT THIS ONE GETS
 *
 * A folder. `DepartmentIcon` is the fallback and it is deliberately mute about
 * its contents: an operator who files their catalogue under names of their own
 * gets a strip of folders, which says "these are departments" and nothing it
 * cannot back up. The alternative — guessing a picture from a keyword — is the
 * failure `components/icons.tsx` writes down at length, where a buyer of
 * laboratory glassware is shown a building site.
 */
import {
  AgricultureIcon,
  AutomotiveIcon,
  BeautyIcon,
  BooksIcon,
  BuildingIcon,
  ChemicalsIcon,
  CleaningIcon,
  ClothingIcon,
  ComputersIcon,
  DepartmentIcon,
  ElectricalIcon,
  ElectronicsIcon,
  EnergyIcon,
  FoodServiceIcon,
  FurnitureIcon,
  HomeKitchenIcon,
  IndustrialIcon,
  LaboratoryIcon,
  MedicalDevicesIcon,
  OfficeIcon,
  PackagingIcon,
  PhonesIcon,
  SafetyIcon,
  SportsIcon,
  ToolsIcon,
  ToysIcon,
  type DepartmentMark,
} from '@/components/department-icons';

/**
 * Department name patterns, narrowest first.
 *
 * ORDER IS THE RULE, exactly as in its two sibling files. "Electronics" has to
 * be tested before "Electrical" would take it, "Computers" before
 * "Electronics" claims the IT department, "Food Service" before "Home &
 * Kitchen" claims the catering one, and "Safety" before "Protective Clothing"
 * reaches the clothing rule.
 */
const RECOGNISED: readonly [RegExp, DepartmentMark][] = [
  // --- health, laboratory, safety, hygiene ----------------------------
  [/\bmedical\b|\bhealthcare\b|\bclinical\b|\bsurgical\b|\bpatient\s*care\b/, MedicalDevicesIcon],
  [/\blaborator(y|ies)\b|\bscientific\b|\bdiagnostics?\b|\breagents?\b/, LaboratoryIcon],
  [/\bsafety\b|\bprotective\b|\bppe\b|\bhi[-\s]?vis\b/, SafetyIcon],
  [/\bclean(ing|liness)?\b|\bhygiene\b|\bjanitorial\b|\bsanit(ary|ation)\b/, CleaningIcon],

  // --- industry, trade, materials -------------------------------------
  [/\bindustrial\b|\bmachinery\b|\bmanufacturing\b/, IndustrialIcon],
  [/\btools?\b|\bhardware\b|\bfasteners?\b/, ToolsIcon],
  [/\bbuilding\b|\bconstruction\b|\bmasonry\b|\bplumbing\b/, BuildingIcon],
  [/\bchemicals?\b|\braw\s*materials?\b|\bsolvents?\b/, ChemicalsIcon],
  [/\benergy\b|\benvironment(al)?\b|\bsolar\b|\brenewables?\b/, EnergyIcon],

  // --- electrical and electronic, narrowest first ---------------------
  [/\bcomputers?\b|\b(it|ict)\b|\blaptops?\b|\bservers?\b|\bnetworking\b/, ComputersIcon],
  [/\bphones?\b|\bmobile\b|\bcommunications?\b|\btelecom\b/, PhonesIcon],
  [/\belectronics?\b|\bcomponents?\b|\bcircuits?\b|\bsemiconductors?\b/, ElectronicsIcon],
  [/\belectrical\b|\blighting\b|\bcabl(e|ing)\b|\bluminaires?\b/, ElectricalIcon],

  // --- the workplace --------------------------------------------------
  [/\boffice\b|\bstationer(y|ies)\b|\bpaper\b/, OfficeIcon],
  [/\bpackag(ing|e)\b|\bshipping\b|\bcartons?\b|\bpallets?\b/, PackagingIcon],
  [/\bfurniture\b|\bfixtures?\b|\bseating\b|\bshelving\b/, FurnitureIcon],

  // --- transport, land, catering, home --------------------------------
  [/\bautomotive\b|\bvehicles?\b|\btransport\b|\bspare\s*parts?\b/, AutomotiveIcon],
  [/\bagricultur(e|al)\b|\bgarden(ing)?\b|\bhorticultur(e|al)\b|\bfarm(ing)?\b/, AgricultureIcon],
  [/\bfood\s*service\b|\bcatering\b|\bhospitality\b/, FoodServiceIcon],
  [/\bhome\b|\bkitchen(ware)?\b|\bhousehold\b/, HomeKitchenIcon],

  // --- consumer -------------------------------------------------------
  [/\bcloth(ing|es)\b|\btextiles?\b|\buniforms?\b|\bworkwear\b|\bapparel\b/, ClothingIcon],
  [/\bbeauty\b|\bskincare\b|\bpersonal\s*care\b|\bcosmetics?\b/, BeautyIcon],
  [/\bsports?\b|\boutdoors?\b|\bfitness\b|\bcamping\b/, SportsIcon],
  [/\btoys?\b|\bhobb(y|ies)\b|\bcrafts?\b/, ToysIcon],
  [/\bbooks?\b|\bmedia\b|\bliterature\b|\bpublications?\b/, BooksIcon],
];

/**
 * The mark for a department.
 *
 * Matched case- and space-insensitively against the name, and against the slug
 * as a second chance — the same two haystacks `categoryCover` uses, and for
 * the same reason: a department named in German is still slugged in the
 * operator's own words often enough to be worth one extra test.
 */
export function departmentMark(name: string, slug: string): DepartmentMark {
  const haystacks = [
    name.toLocaleLowerCase('en-GB').replace(/[^a-z0-9]+/g, ' ').trim(),
    slug.toLocaleLowerCase('en-GB').replace(/[^a-z0-9]+/g, ' ').trim(),
  ];

  for (const [pattern, mark] of RECOGNISED) {
    if (haystacks.some((haystack) => pattern.test(haystack))) return mark;
  }

  return DepartmentIcon;
}
