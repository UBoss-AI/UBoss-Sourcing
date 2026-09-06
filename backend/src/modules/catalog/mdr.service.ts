/**
 * Medical device information, and whether a listing carries enough of it.
 *
 * > **This is not MDR compliance.** Regulation (EU) 2017/745 is a quality
 * > management system, a clinical evaluation, post-market surveillance, PSURs
 * > and vigilance reporting. A catalogue cannot hold any of that. What it can
 * > hold is the part a buyer and a market surveillance authority read off the
 * > listing — which device this is, what class it falls in, who certified it
 * > and what it is for — and that is all this file claims to check.
 *
 * The rule that carries the weight is the notified body one, and it is the
 * reason `DeviceClass` subdivides Class I at all.
 *
 * A plain Class I device is self-certified: the manufacturer signs the
 * declaration of conformity and no notified body is involved. But a Class I
 * device that is **supplied sterile**, has a **measuring function**, or is a
 * **reusable surgical instrument** needs a notified body for that specific
 * aspect — sterility, metrology, or reprocessing respectively — and its CE
 * marking carries that body's four-digit number. Everything from IIa upwards
 * needs one outright.
 *
 * A validator that treated "Class I" as one thing would let a sterile syringe
 * publish with no NB number beside its CE mark, which is exactly the listing
 * this is here to stop.
 */
import { prisma } from '../../infra/prisma.js';

export const DeviceClass = {
  CLASS_I: 'CLASS_I',
  CLASS_I_STERILE: 'CLASS_I_STERILE',
  CLASS_I_MEASURING: 'CLASS_I_MEASURING',
  CLASS_I_REUSABLE_SURGICAL: 'CLASS_I_REUSABLE_SURGICAL',
  CLASS_IIA: 'CLASS_IIA',
  CLASS_IIB: 'CLASS_IIB',
  CLASS_III: 'CLASS_III',
} as const;

export type DeviceClassValue = (typeof DeviceClass)[keyof typeof DeviceClass];

/**
 * Classes that self-certify.
 *
 * Exactly one: plain Class I. Every other value in the enum involves a
 * notified body, which is why the enum has the shape it does.
 */
const SELF_CERTIFIED: readonly DeviceClassValue[] = [DeviceClass.CLASS_I];

/**
 * Whether this class requires a notified body number on the listing.
 *
 * Exported because the admin panel shows the answer live as somebody picks a
 * class — the field appearing and becoming required is the clearest way to
 * teach the rule, and better than a paragraph nobody reads.
 */
export function requiresNotifiedBody(deviceClass: DeviceClassValue): boolean {
  return !SELF_CERTIFIED.includes(deviceClass);
}

export interface MdrGap {
  field: string;
  code: string;
  message: string;
}

export interface MdrAssessment {
  /** True when the product is not a device at all - nothing to check. */
  notADevice: boolean;
  compliant: boolean;
  /** Whether these gaps currently block publication. */
  enforced: boolean;
  gaps: MdrGap[];
  /** Storefront languages with no translated intended purpose. */
  missingPurposeLanguages: string[];
}

export interface MdrFacts {
  deviceClass: DeviceClassValue;
  basicUdiDi: string | null;
  udiDi: string | null;
  notifiedBodyNumber: string | null;
  intendedPurpose: string | null;
  isSterile: boolean;
  hasMeasuringFunction: boolean;
  /** Languages that already carry a translated intended purpose. */
  purposeLanguages?: readonly string[];
  storefrontLanguages?: readonly string[];
  /** The Eudamed SRN of whoever manufactures it, when one is on file. */
  manufacturerSrn?: string | null;
}

function filled(value: string | null | undefined): boolean {
  return (value ?? '').trim().length > 0;
}

/**
 * A four-digit notified body number, as it appears beside a CE mark.
 *
 * Checked for shape rather than against a list: NANDO is the authoritative
 * register, it changes, and a codebase that shipped a copy of it would be
 * wrong within months and confidently so. A shape check catches the typo —
 * somebody entering a certificate number instead — without pretending to
 * knowledge it does not have.
 */
function looksLikeNotifiedBody(value: string): boolean {
  return /^\d{4}$/.test(value.trim());
}

/**
 * Assess one device listing.
 *
 * Pure, so the rule set is testable without a database.
 */
export function assessMdr(
  facts: MdrFacts | null,
  enforced: boolean,
): MdrAssessment {
  if (facts === null) {
    // Not a device. Nothing here applies, and saying "compliant" would be
    // claiming something about a product this regulation never reaches.
    return {
      notADevice: true,
      compliant: true,
      enforced,
      gaps: [],
      missingPurposeLanguages: [],
    };
  }

  const gaps: MdrGap[] = [];

  // Art. 27 and Annex VI Part C. Two identifiers doing two jobs: the Basic
  // UDI-DI is what the declaration of conformity and the Eudamed entry are
  // filed against; the UDI-DI is what appears on the label.
  if (!filled(facts.basicUdiDi)) {
    gaps.push({
      field: 'basicUdiDi',
      code: 'BASIC_UDI_DI_REQUIRED',
      message:
        'MDR Art. 27: the Basic UDI-DI identifies the device group that the declaration of ' +
        'conformity and the Eudamed entry are filed against.',
    });
  }

  if (!filled(facts.udiDi)) {
    gaps.push({
      field: 'udiDi',
      code: 'UDI_DI_REQUIRED',
      message:
        'MDR Art. 27: the UDI-DI identifies this specific packaging configuration and appears ' +
        'on the label. It is not the same identifier as the Basic UDI-DI.',
    });
  }

  // Art. 52 and Annex IX-XI, via the class.
  if (requiresNotifiedBody(facts.deviceClass)) {
    if (!filled(facts.notifiedBodyNumber)) {
      gaps.push({
        field: 'notifiedBodyNumber',
        code: 'NOTIFIED_BODY_REQUIRED',
        message:
          `A ${humanClass(facts.deviceClass)} device is certified by a notified body, and its ` +
          'four-digit number appears beside the CE marking. Give it here.',
      });
    } else if (!looksLikeNotifiedBody(facts.notifiedBodyNumber ?? '')) {
      gaps.push({
        field: 'notifiedBodyNumber',
        code: 'NOTIFIED_BODY_MALFORMED',
        message:
          'A notified body number is four digits, e.g. 0123. This looks like a certificate ' +
          'number rather than the body’s identification number.',
      });
    }
  }

  // The trap this whole enum exists to catch: a device declared plain Class I
  // that is nonetheless sterile or measuring. Both need a notified body for
  // that aspect, and neither is visible from the class alone.
  if (facts.deviceClass === DeviceClass.CLASS_I) {
    if (facts.isSterile) {
      gaps.push({
        field: 'deviceClass',
        code: 'STERILE_CLASS_I',
        message:
          'This is marked Class I and supplied sterile. Sterility is certified by a notified ' +
          'body, so the class is Class I (sterile) and an NB number is required.',
      });
    }

    if (facts.hasMeasuringFunction) {
      gaps.push({
        field: 'deviceClass',
        code: 'MEASURING_CLASS_I',
        message:
          'This is marked Class I and has a measuring function. The metrological aspect is ' +
          'certified by a notified body, so the class is Class I (measuring) and an NB number ' +
          'is required.',
      });
    }
  }

  // Art. 10(11) / Annex I ch. III: what the device is for.
  if (!filled(facts.intendedPurpose)) {
    gaps.push({
      field: 'intendedPurpose',
      code: 'INTENDED_PURPOSE_REQUIRED',
      message:
        'MDR Art. 10(11): state the intended purpose in the manufacturer’s own words. It is ' +
        'what decides the device’s classification and what a buyer checks it against.',
    });
  }

  // Art. 31: the manufacturer's Eudamed registration. A gap rather than a
  // blocker on the device itself - it belongs to the company record, and the
  // message says where to fix it.
  if (facts.manufacturerSrn !== undefined && !filled(facts.manufacturerSrn)) {
    gaps.push({
      field: 'manufacturerSrn',
      code: 'EUDAMED_SRN_MISSING',
      message:
        'MDR Art. 31: the manufacturer has no Eudamed Single Registration Number on file. Add ' +
        'it on their company record under Catalogue → Manufacturers.',
    });
  }

  const offered = facts.storefrontLanguages ?? [];
  const translated = new Set(facts.purposeLanguages ?? []);

  const missingPurposeLanguages = filled(facts.intendedPurpose)
    ? offered.filter((language) => !translated.has(language))
    : [];

  return {
    notADevice: false,
    compliant: gaps.length === 0,
    enforced,
    gaps,
    missingPurposeLanguages,
  };
}

/** The class as a person says it, for a message. */
function humanClass(deviceClass: DeviceClassValue): string {
  switch (deviceClass) {
    case DeviceClass.CLASS_I:
      return 'Class I';
    case DeviceClass.CLASS_I_STERILE:
      return 'Class I (sterile)';
    case DeviceClass.CLASS_I_MEASURING:
      return 'Class I (measuring)';
    case DeviceClass.CLASS_I_REUSABLE_SURGICAL:
      return 'Class I (reusable surgical)';
    case DeviceClass.CLASS_IIA:
      return 'Class IIa';
    case DeviceClass.CLASS_IIB:
      return 'Class IIb';
    case DeviceClass.CLASS_III:
      return 'Class III';
  }
}

/** Load the facts and assess, for one product. */
export async function assessProductMdr(
  productId: string,
  storefrontLanguages: readonly string[],
): Promise<MdrAssessment> {
  const [product, business] = await Promise.all([
    prisma.product.findUnique({
      where: { id: productId },
      select: {
        deviceInfo: true,
        manufacturer: { select: { eudamedSrn: true } },
        translations: {
          where: { intendedPurpose: { not: null } },
          select: { language: true },
        },
      },
    }),
    prisma.businessProfile.findFirst({ select: { mdrEnforced: true } }),
  ]);

  const enforced = business?.mdrEnforced ?? false;

  if (product?.deviceInfo === null || product?.deviceInfo === undefined) {
    return assessMdr(null, enforced);
  }

  const info = product.deviceInfo;

  return assessMdr(
    {
      deviceClass: info.deviceClass,
      basicUdiDi: info.basicUdiDi,
      udiDi: info.udiDi,
      notifiedBodyNumber: info.notifiedBodyNumber,
      intendedPurpose: info.intendedPurpose,
      isSterile: info.isSterile,
      hasMeasuringFunction: info.hasMeasuringFunction,
      purposeLanguages: product.translations.map((row) => row.language),
      storefrontLanguages,
      // Only asked about when there IS a manufacturer: "no SRN" on a listing
      // with no manufacturer at all is the GPSR gap, reported there, and
      // saying it twice teaches people to skim both.
      ...(product.manufacturer === null
        ? {}
        : { manufacturerSrn: product.manufacturer.eudamedSrn }),
    },
    enforced,
  );
}

/** Whether this deployment blocks publication on the checks above. */
export async function mdrEnforced(): Promise<boolean> {
  const business = await prisma.businessProfile.findFirst({ select: { mdrEnforced: true } });
  return business?.mdrEnforced ?? false;
}
