/**
 * Which mark a department gets.
 *
 * Two answers, in order.
 *
 * **A drawn medical icon, where the name is one this catalogue recognises.**
 * A cannula beside "IV Cannula" cannot be wrong about what is in the
 * department, and a buyer scanning twenty-two of them finds the one they came
 * for by shape before they finish reading the labels.
 *
 * **One of six abstract stock shapes otherwise.** That is what every category
 * had before, and it stays the answer for a name this file has never seen -
 * see the note in `components/icons.tsx` about why a literal picture beside a
 * department nobody has described is worse than no picture at all.
 *
 * Matching is on the category NAME rather than the slug, because the same
 * department is slugged differently in two deployments and named the same way
 * in both. It is case- and space-insensitive, and it is deliberately made of
 * whole words: a rule that matched "cannula" anywhere would also claim
 * "Cannula Dressings", which is a dressing.
 *
 * ORDER IS THE RULE. The first pattern that matches wins, so the narrow names
 * come before the broad ones - "Closed IV Cannula" has to be tested before
 * "IV Cannula", and "ABG Kit" before "ABG Syringe" would otherwise take it.
 */
import {
  BloodGasSyringeIcon,
  CannulaIcon,
  ClosedCannulaIcon,
  DiaperIcon,
  DisinfectantCapIcon,
  EnteralSyringeIcon,
  FeedingTubeIcon,
  GloveIcon,
  GlycerineIcon,
  InfusionSetIcon,
  LineAccessIcon,
  OralSyringeIcon,
  PrefilledSyringeIcon,
  RylesTubeIcon,
  SafetyNeedleIcon,
  SamplingKitIcon,
  SterileWaterIcon,
  SuctionCatheterIcon,
  SyringeIcon,
  type CategoryMark,
} from '@/components/category-icons';
import {
  BoxIcon,
  CylinderIcon,
  FlowIcon,
  GridIcon,
  HexIcon,
  LayersIcon,
} from '@/components/icons';

/**
 * Name patterns, narrowest first.
 *
 * Every entry is a department this catalogue actually has. Adding one is a
 * deliberate statement that a picture of that thing is correct beside that
 * name - not a guess from a keyword.
 */
const RECOGNISED: readonly [RegExp, CategoryMark][] = [
  // --- the narrow ones, which must beat the broad ones below ---
  [/\bclosed\b.*\bcannulae?s?\b/, ClosedCannulaIcon],
  [/\bsafety\b.*\bneedles?\b|\bneedles?\b.*\bsafety\b/, SafetyNeedleIcon],
  [/\babg\b.*\bkits?\b|\bblood\b.*\b(sampling|collect)\b/, SamplingKitIcon],
  [/\babg\b|\bblood\s*gas\b|\barterial\b/, BloodGasSyringeIcon],
  [/\bglycerine?\b|\bglycerol\b/, GlycerineIcon],
  [/\bsterile\s*water\b/, SterileWaterIcon],
  [/\benfit\b|\benteral\b/, EnteralSyringeIcon],
  [/\boral\b.*\bsyringes?\b|\boral\b.*\bsyiringes?\b|\boral\s*dosing\b/, OralSyringeIcon],
  [/\binfant\b.*\bfeed/, FeedingTubeIcon],
  [/\bryles?\b|\bnaso\s*gastric\b|\bnasogastric\b/, RylesTubeIcon],
  [/\bsuction\b/, SuctionCatheterIcon],
  [/\bdisinfect/, DisinfectantCapIcon],
  [/\bdiaper\b|\bincontinence\b|\bbrief\b/, DiaperIcon],
  [/\bglove/, GloveIcon],

  // --- the families ---
  [/\bcannulae?s?\b/, CannulaIcon],
  [/\binfusions?\b|\badministration\s*sets?\b|\bdrip\b/, InfusionSetIcon],
  [/\bline\s*access\b|\bextension\s*lines?\b/, LineAccessIcon],
  [
    // Every remaining prefilled syringe department: flush, heparin, citrate.
    /\bflush\b|\bheparin\b|\bcitrate\b|\bpre[-\s]?filled\b|\bprefilled\b/,
    PrefilledSyringeIcon,
  ],
  [/\bsyringes?\b|\bsyiringes?\b|\bneedles?\b/, SyringeIcon],
];

/** The abstract fallback set, unchanged from what every category used to get. */
const ABSTRACT: readonly CategoryMark[] = [
  BoxIcon,
  HexIcon,
  LayersIcon,
  GridIcon,
  CylinderIcon,
  FlowIcon,
];

/**
 * The unrecognised case: the same shape for the same department every time.
 *
 * Hashed from the slug rather than chosen by position, so a department does
 * not change its picture when another one is added above it in the list.
 */
function abstractMark(seed: string): CategoryMark {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100_003;
  }
  return ABSTRACT[hash % ABSTRACT.length] ?? BoxIcon;
}

export function categoryMark(name: string, slug: string): CategoryMark {
  // Punctuation out, single spaces, lowercase: "DC Flush Syringe(Swab Cap)"
  // and "dc flush syringe (swab cap)" are one department.
  const normalised = name
    .toLocaleLowerCase('en-GB')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  for (const [pattern, mark] of RECOGNISED) {
    if (pattern.test(normalised)) return mark;
  }

  return abstractMark(slug);
}
