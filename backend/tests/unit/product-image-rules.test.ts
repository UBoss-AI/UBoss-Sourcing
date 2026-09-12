/**
 * Which photograph goes on which product.
 *
 * This table makes a claim about a medical device, so the cases that matter
 * are the ones where a wrong answer would still look right.
 *
 *   * **Order.** "Closed IV Cannula" contains "IV Cannula" and "Sterile Water
 *     With 10% Glycerine" contains "Sterile Water". A list that tested the
 *     broad name first would put a plain cannula on a closed-system one and
 *     plain water on the glycerine — both plausible enough that nobody would
 *     query them.
 *
 *   * **Refusing.** An insulin syringe is not a hypodermic syringe: same
 *     shape, same colour, different graduations, and the graduations are the
 *     product. There is no photograph of one, so it gets none.
 *
 *   * **Never inventing.** Nine departments have no photograph in the folder.
 *     Every one of them must come back null rather than reaching for something
 *     near enough.
 */
import { describe, expect, it } from 'vitest';
import {
  imageRuleFor,
  PRODUCT_IMAGE_RULES,
} from '../../src/modules/catalog/product-images/image-rules.js';

/** Shorthand: most rules key off the department alone. */
function fileFor(categoryName: string, genericName = '', brand = ''): string | null {
  return imageRuleFor({ categoryName, genericName, brand })?.file ?? null;
}

describe('product photographs', () => {
  it('puts the right photograph on each department that has one', () => {
    expect(fileFor('IV CANNULA', 'I.V. Cannula', 'Veinfix')).toBe('iv-cannula.jpg');
    expect(fileFor('CLOSED IV CANNULA', '', 'EASY VEIN CONTROL WAY')).toBe('closed-iv-cannula.jpg');
    expect(fileFor('INFUSION SET', 'infusion set', 'ACCU FLOW')).toBe('infusion-set.jpg');
    expect(fileFor('SAFETY NEEDLE', '', 'Easy Safy Pric')).toBe('safety-needle.jpg');
    expect(fileFor('FLUSH SYRINGE', '', 'Easy Flush')).toBe('flush-syringe.jpg');
    expect(fileFor('DC FLUSH SYRINGE(SWAB CAP)', '', 'Easy Flush')).toBe('flush-syringe.jpg');
    expect(fileFor('PREFILLED HEPARIN SYRINGE', '', 'Easy Flush Heparin')).toBe(
      'heparin-flush-syringe.jpg',
    );
    expect(fileFor('SODIUM CITRATE PREFILLED SYRINGE', '', 'EASY FLUSH CITRA SAFE 4%')).toBe(
      'citrate-flush-syringe.jpg',
    );
    expect(fileFor('STERILE WATER', '', 'EASY FILL AQUA')).toBe('sterile-water-syringe.jpg');
    expect(fileFor('ABG SYRINGE', '', 'EASY BLOOD COLLECT')).toBe('abg-syringe.jpg');
    expect(fileFor('ABG KIT', '', 'ARTERIAL BLOOD SAMPLING KIT')).toBe('abg-sampling-kit.jpg');
  });

  it('tests the narrow department before the one whose name it contains', () => {
    // Both of these would match a broader rule further down the list.
    expect(fileFor('CLOSED IV CANNULA')).not.toBe('iv-cannula.jpg');
    expect(fileFor('STERILE WATER WITH 10% GLYCERINE')).toBe('glycerine-syringe.jpg');
  });

  it('uses the winged safety photograph only where the brand says safety', () => {
    expect(fileFor('IV CANNULA', 'I.V. Cannula', 'Easy Vein safy super')).toBe(
      'iv-cannula-safety-winged.jpg',
    );
    expect(fileFor('IV CANNULA', 'I.V. Cannula', 'ACCU VEIN SAFY')).toBe(
      'iv-cannula-safety-winged.jpg',
    );
    // "EASY VEIN WIN" suggests wings and does not state them. A guess here
    // would put a safety guard on a cannula that has not got one.
    expect(fileFor('IV CANNULA', 'I.V. Cannula', 'EASY VEIN WIN')).toBe('iv-cannula.jpg');
  });

  it('will not stand a hypodermic syringe in for an insulin syringe', () => {
    // Same department, two genuinely different products. Only the one the
    // photograph actually shows gets it.
    expect(fileFor('Insulin Syringe', 'Disposable Hypodermic Syringe', 'ACCU SHOT ONE')).toBe(
      'hypodermic-syringe.jpg',
    );
    expect(fileFor('Insulin Syringe', 'Auto Disable (AD) Syringes for Immunization', 'COVAX JET')).toBe(
      'hypodermic-syringe.jpg',
    );
    expect(fileFor('Insulin Syringe', 'Insulin Syringe', 'ACCU SHOT U-100')).toBeNull();
  });

  it('gives nothing to the departments with no photograph', () => {
    // Every one of these is a real department with real products and no shot
    // of it in Images/. Null is the answer until somebody photographs one.
    for (const department of [
      'Oral Dosing Syringe',
      'ORAL SYIRINGE',
      'Enfit syringe',
      'Surgical Gloves',
      'Suction Catheter',
      'Ryles Tube',
      'Infant Feeding Tube',
      'Adult diaper',
      'Disinfectant Cap',
    ]) {
      expect(fileFor(department), department).toBeNull();
    }
  });

  it('reads a department name however it is punctuated or cased', () => {
    expect(fileFor('dc flush syringe (swab cap)')).toBe('flush-syringe.jpg');
    expect(fileFor('IV  Administration   Sets')).toBe('infusion-set.jpg');
  });

  it('describes every photograph for a reader who cannot see it', () => {
    for (const rule of PRODUCT_IMAGE_RULES) {
      // Alt text describes the picture. A one-word label would be worse than
      // none, and an empty string marks an image as decorative — which a
      // product photograph is not.
      expect(rule.altText.length, rule.file).toBeGreaterThan(40);
      expect(rule.file, rule.file).toMatch(/^[a-z0-9-]+\.jpg$/);
    }
  });
});
