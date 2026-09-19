/**
 * The template registry is a contract with the category tree.
 *
 * Every slug named in a template has to exist in the starter categories seed,
 * and every non-medical subcategory the seed plants has to have a template.
 * Either half drifting is silent in production - a seller on that shelf simply
 * gets the free-form editor and nobody notices for a month - so it is asserted
 * here, against the seed itself rather than against a copied list.
 */
import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_COUNT,
  VARIANT_TEMPLATES,
  findAxis,
  findTemplate,
  isKnownDepartment,
  resolveActiveAxes,
} from '../../src/domain/variants/registry.js';
import { STARTER_DEPARTMENTS } from '../../src/seed/starter-departments.js';

const MEDICAL_SLUG = 'medical-devices';

const nonMedicalDepartments = STARTER_DEPARTMENTS.filter(
  (department) => department.slug !== MEDICAL_SLUG,
);

describe('variant template registry', () => {
  it('covers all 24 non-medical departments and all 112 subcategories', () => {
    expect(nonMedicalDepartments).toHaveLength(24);

    const seededChildren = nonMedicalDepartments.flatMap((department) => department.children);
    expect(seededChildren).toHaveLength(112);
    expect(TEMPLATE_COUNT).toBe(112);
  });

  it('has a template for every seeded non-medical subcategory', () => {
    const missing = nonMedicalDepartments.flatMap((department) =>
      department.children
        .filter((child) => findTemplate([child.slug, department.slug]) === null)
        .map((child) => child.slug),
    );

    expect(missing).toEqual([]);
  });

  it('names only slugs the seed actually plants', () => {
    const seededSubcategories = new Set(
      nonMedicalDepartments.flatMap((department) => department.children.map((child) => child.slug)),
    );
    const seededDepartments = new Set(nonMedicalDepartments.map((department) => department.slug));

    for (const entry of VARIANT_TEMPLATES) {
      expect(seededDepartments.has(entry.categorySlug), entry.categorySlug).toBe(true);
      expect(entry.subcategorySlug).not.toBeNull();
      expect(seededSubcategories.has(entry.subcategorySlug ?? ''), entry.subcategorySlug ?? '').toBe(
        true,
      );
    }
  });

  it('leaves Medical Devices without a template, so its picker is untouched', () => {
    const medical = STARTER_DEPARTMENTS.find((department) => department.slug === MEDICAL_SLUG);
    expect(medical).toBeDefined();

    for (const child of medical?.children ?? []) {
      expect(findTemplate([child.slug, MEDICAL_SLUG])).toBeNull();
    }
    expect(isKnownDepartment(MEDICAL_SLUG)).toBe(false);
  });

  it('gives every axis a unique key, a sort order and no self-dependency', () => {
    for (const entry of VARIANT_TEMPLATES) {
      const keys = entry.axes.map((candidate) => candidate.key);
      expect(new Set(keys).size, `${entry.subcategorySlug ?? ''} has duplicate axis keys`).toBe(
        keys.length,
      );

      entry.axes.forEach((candidate, index) => {
        expect(candidate.sortOrder).toBe(index);
        expect(candidate.affectsSku).toBe(true);

        for (const dependency of candidate.dependsOn ?? []) {
          expect(dependency).not.toBe(candidate.key);
          // A dependency must be an axis of the same template, and must come
          // before the axis that needs it - otherwise the selector would block
          // a control on an answer it has not asked for yet.
          const target = entry.axes.findIndex((other) => other.key === dependency);
          expect(target, `${entry.subcategorySlug ?? ''} -> ${dependency}`).toBeGreaterThanOrEqual(
            0,
          );
          expect(target).toBeLessThan(index);
        }
      });
    }
  });

  it('resolves a category by its own slug, falling back to its parent shelf', () => {
    // A shelf an operator added of their own under Footwear resolves to
    // Footwear's template, because that is what a subcategory of it is.
    const found = findTemplate(['safety-boots-we-added', 'footwear', 'clothing-textiles']);
    expect(found?.subcategorySlug).toBe('footwear');
  });

  it('resolves a department slug on its own to nothing', () => {
    expect(findTemplate(['clothing-textiles'])).toBeNull();
  });

  it('keeps footwear size behind its size system', () => {
    const footwear = findTemplate(['footwear']);
    expect(footwear).not.toBeNull();

    const size = findAxis(footwear!, 'size');
    expect(size?.dependsOn).toContain('size_system');
    expect(size?.sort).toBe('NUMERIC');
    expect(findAxis(footwear!, 'size_system')?.allowsCustomValues).toBe(false);
  });

  it('sorts apparel sizes semantically, not alphabetically', () => {
    const clothing = findTemplate(['everyday-clothing']);
    expect(findAxis(clothing!, 'size')?.sort).toBe('APPAREL');
  });
});

describe('resolveActiveAxes', () => {
  const footwear = findTemplate(['footwear']);

  it('returns only the axes a product switched on, in template order', () => {
    const active = resolveActiveAxes(footwear, ['colour', 'size', 'size_system']);
    expect(active.map((entry) => entry.key)).toEqual(['size_system', 'size', 'colour']);
  });

  it('discards a key the template does not know, rather than inventing an axis', () => {
    const active = resolveActiveAxes(footwear, ['size', 'blade_length']);
    expect(active.map((entry) => entry.key)).toEqual(['size']);
  });

  it('returns nothing for a category with no template', () => {
    expect(resolveActiveAxes(null, ['size'])).toEqual([]);
  });
});
