/**
 * The MDR listing checklist.
 *
 * The case worth the most attention is the Class I subdivision, because it is
 * the one a plausible implementation gets wrong.
 *
 * A plain Class I device is self-certified — no notified body, no NB number
 * beside the CE mark. But a Class I device supplied **sterile**, one with a
 * **measuring function**, or a **reusable surgical instrument** each need a
 * notified body for that specific aspect. A validator that treated "Class I"
 * as one thing would let a sterile syringe publish with a bare CE mark, which
 * is exactly the listing this exists to stop.
 *
 * The second case is the trap in the other direction: a device declared plain
 * Class I whose own flags say it is sterile. The class and the flags disagree,
 * and the flags are the ones describing the physical product.
 */
import { describe, expect, it } from 'vitest';
import { DeviceClass, assessMdr, requiresNotifiedBody } from '../../src/modules/catalog/mdr.service.js';

/** A complete Class IIa listing, for the tests that remove one thing. */
const COMPLETE = {
  deviceClass: DeviceClass.CLASS_IIA,
  basicUdiDi: '5060123456789AB',
  udiDi: '05060123456789',
  notifiedBodyNumber: '0123',
  intendedPurpose: 'Intravenous administration of fluids to a patient.',
  isSterile: true,
  hasMeasuringFunction: false,
};

describe('requiresNotifiedBody', () => {
  it('is false only for plain Class I', () => {
    expect(requiresNotifiedBody(DeviceClass.CLASS_I)).toBe(false);
  });

  it('is true for every Class I subdivision', () => {
    // The whole reason the enum subdivides Class I. Sterility, metrology and
    // reprocessing are each certified by a notified body.
    expect(requiresNotifiedBody(DeviceClass.CLASS_I_STERILE)).toBe(true);
    expect(requiresNotifiedBody(DeviceClass.CLASS_I_MEASURING)).toBe(true);
    expect(requiresNotifiedBody(DeviceClass.CLASS_I_REUSABLE_SURGICAL)).toBe(true);
  });

  it('is true from Class IIa upwards', () => {
    expect(requiresNotifiedBody(DeviceClass.CLASS_IIA)).toBe(true);
    expect(requiresNotifiedBody(DeviceClass.CLASS_IIB)).toBe(true);
    expect(requiresNotifiedBody(DeviceClass.CLASS_III)).toBe(true);
  });
});

describe('assessMdr', () => {
  it('says nothing about a product that is not a device', () => {
    const result = assessMdr(null, true);

    // "Compliant" here means "this regulation does not reach it", not "it
    // passed" — and `notADevice` is what lets the screen say so rather than
    // showing a green tick nobody earned.
    expect(result.notADevice).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it('passes a complete listing', () => {
    const result = assessMdr(COMPLETE, true);

    expect(result.compliant).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it('requires both UDI identifiers, which are not the same thing', () => {
    const noBasic = assessMdr({ ...COMPLETE, basicUdiDi: null }, true);
    const noDi = assessMdr({ ...COMPLETE, udiDi: null }, true);

    // The Basic UDI-DI is what the declaration of conformity and the Eudamed
    // entry are filed against; the UDI-DI is what appears on the label.
    // Neither is derivable from the other.
    expect(noBasic.gaps.map((gap) => gap.code)).toContain('BASIC_UDI_DI_REQUIRED');
    expect(noDi.gaps.map((gap) => gap.code)).toContain('UDI_DI_REQUIRED');
  });

  it('requires a notified body number from Class IIa upwards', () => {
    const result = assessMdr({ ...COMPLETE, notifiedBodyNumber: null }, true);

    expect(result.gaps.map((gap) => gap.code)).toContain('NOTIFIED_BODY_REQUIRED');
    expect(result.gaps.find((gap) => gap.code === 'NOTIFIED_BODY_REQUIRED')?.message).toContain(
      'Class IIa',
    );
  });

  it('does not ask a plain Class I device for a notified body', () => {
    const result = assessMdr(
      {
        ...COMPLETE,
        deviceClass: DeviceClass.CLASS_I,
        notifiedBodyNumber: null,
        isSterile: false,
      },
      true,
    );

    expect(result.gaps.map((gap) => gap.code)).not.toContain('NOTIFIED_BODY_REQUIRED');
    expect(result.compliant).toBe(true);
  });

  it('catches a plain Class I device that is nonetheless sterile', () => {
    const result = assessMdr(
      {
        ...COMPLETE,
        deviceClass: DeviceClass.CLASS_I,
        notifiedBodyNumber: null,
        isSterile: true,
      },
      true,
    );

    // The class and the flags disagree, and the flags describe the physical
    // product. Sterility is certified by a notified body, so this is Class I
    // (sterile) and needs an NB number.
    expect(result.gaps.map((gap) => gap.code)).toContain('STERILE_CLASS_I');
  });

  it('catches a plain Class I device with a measuring function', () => {
    const result = assessMdr(
      {
        ...COMPLETE,
        deviceClass: DeviceClass.CLASS_I,
        notifiedBodyNumber: null,
        isSterile: false,
        hasMeasuringFunction: true,
      },
      true,
    );

    expect(result.gaps.map((gap) => gap.code)).toContain('MEASURING_CLASS_I');
  });

  it('rejects a certificate number given where a notified body number belongs', () => {
    const result = assessMdr({ ...COMPLETE, notifiedBodyNumber: 'CE-2024-88213' }, true);

    // A notified body number is four digits. The common mistake is pasting the
    // certificate reference, which looks plausible and is not the same thing.
    expect(result.gaps.map((gap) => gap.code)).toContain('NOTIFIED_BODY_MALFORMED');
  });

  it('requires an intended purpose', () => {
    const result = assessMdr({ ...COMPLETE, intendedPurpose: '   ' }, true);

    // Art. 10(11). It is what decides the classification in the first place.
    expect(result.gaps.map((gap) => gap.code)).toContain('INTENDED_PURPOSE_REQUIRED');
  });

  it('asks for the manufacturer’s Eudamed SRN only when there is a manufacturer', () => {
    const withManufacturer = assessMdr({ ...COMPLETE, manufacturerSrn: null }, true);
    const without = assessMdr(COMPLETE, true);

    expect(withManufacturer.gaps.map((gap) => gap.code)).toContain('EUDAMED_SRN_MISSING');
    // Saying it on a listing that has no manufacturer at all would duplicate
    // the GPSR gap and teach people to skim both.
    expect(without.gaps.map((gap) => gap.code)).not.toContain('EUDAMED_SRN_MISSING');
  });

  it('reports every gap at once', () => {
    const result = assessMdr(
      {
        deviceClass: DeviceClass.CLASS_III,
        basicUdiDi: null,
        udiDi: null,
        notifiedBodyNumber: null,
        intendedPurpose: null,
        isSterile: false,
        hasMeasuringFunction: false,
      },
      true,
    );

    expect(result.gaps).toHaveLength(4);
  });

  it('reports the same gaps when enforcement is off, flagged as non-blocking', () => {
    const result = assessMdr({ ...COMPLETE, udiDi: null }, false);

    expect(result.enforced).toBe(false);
    expect(result.compliant).toBe(false);
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  it('names the languages the intended purpose has not reached', () => {
    const result = assessMdr(
      { ...COMPLETE, purposeLanguages: ['de'], storefrontLanguages: ['de', 'nl', 'pl'] },
      true,
    );

    expect(result.missingPurposeLanguages).toEqual(['nl', 'pl']);
    // Never blocking: a purpose in the base language still publishes.
    expect(result.compliant).toBe(true);
  });

  it('does not report translation gaps when there is no purpose to translate', () => {
    const result = assessMdr(
      { ...COMPLETE, intendedPurpose: null, storefrontLanguages: ['de', 'nl'] },
      true,
    );

    // The missing purpose is the finding. Listing languages it has not been
    // translated into would bury it.
    expect(result.missingPurposeLanguages).toEqual([]);
  });
});
