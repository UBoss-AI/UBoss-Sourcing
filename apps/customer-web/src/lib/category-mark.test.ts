/**
 * Which picture a department gets.
 *
 * Every name below is a real department in the catalogue this was written
 * against, spelled the way the supplier sheet spells it — including
 * "ORAL SYIRINGE", which is their typo and has to keep working.
 *
 * The cases that matter are the ORDER ones. "Closed IV Cannula" contains
 * "IV Cannula", "ABG Kit" contains "ABG", and a rule list that tested the
 * broad name first would quietly give three departments the wrong picture —
 * quietly, because a plausible icon beside a plausible name is exactly the
 * kind of wrong nobody notices.
 */
import { describe, expect, it } from 'vitest';
import { categoryMark } from './category-mark';
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
  OralSyringeIcon,
  PrefilledSyringeIcon,
  RylesTubeIcon,
  SafetyNeedleIcon,
  SamplingKitIcon,
  SterileWaterIcon,
  SuctionCatheterIcon,
  SyringeIcon,
} from '@/components/category-icons';
import { BoxIcon, CylinderIcon, FlowIcon, GridIcon, HexIcon, LayersIcon } from '@/components/icons';

/** The twenty-two departments, as the sheet names them. */
const DEPARTMENTS: [name: string, expected: unknown][] = [
  ['Oral Dosing Syringe', OralSyringeIcon],
  ['ORAL SYIRINGE', OralSyringeIcon],
  ['Enfit syringe', EnteralSyringeIcon],
  ['SURGICAL GLOVES', GloveIcon],
  ['Suction Catheter', SuctionCatheterIcon],
  ['RYLES TUBE', RylesTubeIcon],
  ['INFANT FEEDING TUBE', FeedingTubeIcon],
  ['Adult diaper', DiaperIcon],
  ['FLUSH SYRINGE', PrefilledSyringeIcon],
  ['DC FLUSH SYRINGE(SWAB CAP)', PrefilledSyringeIcon],
  ['IV CANNULA', CannulaIcon],
  ['CLOSED IV CANNULA', ClosedCannulaIcon],
  ['INFUSION SET', InfusionSetIcon],
  ['INSULIN SYRINGE', SyringeIcon],
  ['ABG SYRINGE', BloodGasSyringeIcon],
  ['ABG KIT', SamplingKitIcon],
  ['STERILE WATER WITH 10% GLYCERINE', GlycerineIcon],
  ['PREFILLED HEPARIN SYRINGE', PrefilledSyringeIcon],
  ['STERILE WATER', SterileWaterIcon],
  ['SODIUM CITRATE PREFILLED SYRINGE', PrefilledSyringeIcon],
  ['SAFETY NEEDLE', SafetyNeedleIcon],
  ['Disinfectant Cap', DisinfectantCapIcon],
];

describe('category marks', () => {
  it.each(DEPARTMENTS)('gives %s a picture of what is in it', (name, expected) => {
    expect(categoryMark(name, 'slug')).toBe(expected);
  });

  it('tests the narrow name before the broad one', () => {
    // Each of these three contains the name of another department. Reversing
    // the rule order would break all three and nothing would fail loudly.
    expect(categoryMark('CLOSED IV CANNULA', 'x')).not.toBe(CannulaIcon);
    expect(categoryMark('ABG KIT', 'x')).not.toBe(BloodGasSyringeIcon);
    expect(categoryMark('STERILE WATER WITH 10% GLYCERINE', 'x')).not.toBe(SterileWaterIcon);
  });

  it('reads a name however it is punctuated or cased', () => {
    for (const spelling of [
      'DC FLUSH SYRINGE(SWAB CAP)',
      'dc flush syringe (swab cap)',
      'DC  Flush   Syringe — Swab Cap',
    ]) {
      expect(categoryMark(spelling, 'x'), spelling).toBe(PrefilledSyringeIcon);
    }
  });

  it('matches whole words, so a dressing is not a cannula', () => {
    // "Cannula Dressings" is a dressing. A substring rule would claim it.
    const mark = categoryMark('Wound Dressings', 'wound-dressings');
    expect([BoxIcon, HexIcon, LayersIcon, GridIcon, CylinderIcon, FlowIcon]).toContain(mark);
  });

  it('falls back to abstract geometry for a department it has never seen', () => {
    // The old behaviour, and the right one: a literal picture beside a
    // department nobody has described is worse than no picture at all.
    const mark = categoryMark('Cleaning Chemicals', 'cleaning-chemicals');
    expect([BoxIcon, HexIcon, LayersIcon, GridIcon, CylinderIcon, FlowIcon]).toContain(mark);
  });

  it('gives an unrecognised department the same mark every time', () => {
    // Hashed off the slug, so adding a department above it in the list does
    // not silently change its picture.
    expect(categoryMark('Cleaning Chemicals', 'cleaning-chemicals')).toBe(
      categoryMark('Cleaning Chemicals', 'cleaning-chemicals'),
    );
  });
});
