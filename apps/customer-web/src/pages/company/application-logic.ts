/**
 * The logic the company application screens share: wording the server's
 * field problems, the register a registration number belongs to, the save
 * hook, and the address and date helpers. The components that use them are
 * in application-parts.tsx.
 *
 * Field problems come back from the API as `{ field, code }` - never as
 * English - and are worded here in the reader's language, so "NIP_CHECKSUM"
 * is a sentence in Polish on a Polish page and in Greek on a Greek one.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate, TranslationKey } from '@/i18n/i18n-context';
import type { OnboardingStep } from './onboarding-steps';
import { ApiError } from '@/lib/api';
import {
  companyQueryKey,
  saveApplication,
  type AddressKind,
  type ApplicationPatch,
  type CompanyAddress,
  type CompanyApplication,
  type EntityType,
  type Register,
} from '@/lib/buyer-companies';
import { errorMessage } from '@/lib/errors';

/** Every problem code the backend may attach to a field. */
const PROBLEM_CODES = new Set([
  'REQUIRED',
  'COUNTRY_FORMAT',
  'DATE_FORMAT',
  'IN_FUTURE',
  'WEBSITE_FORMAT',
  'EMAIL_FORMAT',
  'INVALID_PHONE',
  'CIN_FORMAT',
  'LLPIN_FORMAT',
  'KRS_FORMAT',
  'NIP_CHECKSUM',
  'REGISTRATION_FORMAT',
  'PAN_FORMAT',
  'GSTIN_SHAPE',
  'GSTIN_STATE',
  'GSTIN_CHECKSUM',
  'UDYAM_FORMAT',
  'IEC_FORMAT',
  'REGON_CHECKSUM',
  'VAT_FORMAT',
  'VAT_PREFIX',
  'VAT_COUNTRY',
  'EORI_FORMAT',
  'LEI_CHECKSUM',
  'TAX_ID_FORMAT',
  'POSTCODE_FORMAT',
  'NOT_APPLICABLE_NOT_ALLOWED',
  'NOT_APPLICABLE_REASON_REQUIRED',
  'SCHEME_NOT_APPLICABLE',
  'DOCUMENT_REQUIRED',
  'UNANSWERED',
  'CONSENT_REQUIRED',
]);

export function problemText(t: Translate, code: string): string {
  return PROBLEM_CODES.has(code)
    ? t(`companyForm.problem.${code}` as TranslationKey)
    : t('companyForm.problem.generic');
}

/** `{ 'business.legalName': 'Enter ...' }` from a refused save. */
export function fieldErrorsFrom(t: Translate, error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const detail of error.details) {
    if (detail.field !== undefined) out[detail.field] = problemText(t, detail.code ?? '');
  }
  return out;
}

/**
 * Which register a registration number belongs to - the same rule as the
 * backend's `registrationRegisterFor`, repeated here only so the label can
 * change the moment the legal form is picked rather than after a save.
 */
export function registerFor(country: string | null, entityType: EntityType | null): Register {
  if (country === 'IN') {
    if (entityType === 'LIMITED_LIABILITY_PARTNERSHIP') return 'IN_LLPIN';
    if (entityType === 'PRIVATE_LIMITED_COMPANY' || entityType === 'PUBLIC_LIMITED_COMPANY') return 'IN_CIN';
    return 'LOCAL';
  }
  if (country === 'PL') return entityType === 'SOLE_PROPRIETORSHIP' ? 'PL_CEIDG' : 'PL_KRS';
  return 'LOCAL';
}

/**
 * Save one step. Returns the saved application, or throws with the field
 * errors already worded - the step shows them beside the fields they belong to.
 */
export function useSaveStep(companyId: string): {
  save: (patch: ApplicationPatch) => Promise<CompanyApplication | null>;
  saving: boolean;
  errors: Record<string, string>;
  formError: string | null;
  clearErrors: () => void;
} {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (patch: ApplicationPatch) => saveApplication(companyId, patch),
    onSuccess: (application) => {
      queryClient.setQueryData(companyQueryKey(companyId), application);
    },
  });

  return {
    saving: mutation.isPending,
    errors,
    formError,
    clearErrors: () => {
      setErrors({});
      setFormError(null);
    },
    save: async (patch) => {
      setErrors({});
      setFormError(null);
      try {
        return await mutation.mutateAsync(patch);
      } catch (error) {
        const fields = fieldErrorsFrom(t, error);
        setErrors(fields);
        setFormError(
          Object.keys(fields).length > 0 ? t('companyForm.fixHighlighted') : errorMessage(t, error),
        );
        return null;
      }
    },
  };
}

export type AddressDraft = Omit<CompanyAddress, 'kind'>;

export const EMPTY_ADDRESS: AddressDraft = {
  line1: '',
  line2: null,
  city: '',
  region: null,
  postalCode: null,
  countryCode: '',
};

export function addressOf(application: CompanyApplication, kind: AddressKind): AddressDraft | null {
  const found = application.addresses.find((address) => address.kind === kind);
  if (found === undefined) return null;
  return {
    line1: found.line1,
    line2: found.line2,
    city: found.city,
    region: found.region,
    postalCode: found.postalCode,
    countryCode: found.countryCode,
  };
}

export function formatDate(value: string | null, locale: string): string {
  if (value === null) return '';
  return new Date(value).toLocaleDateString(locale, { dateStyle: 'medium' });
}

/** The step a problem field belongs to, for "jump to what is missing". */
export function stepOfField(field: string): OnboardingStep {
  if (field.startsWith('applicant') || field === 'businessEmail' || field === 'business.businessEmail') return 'applicant';
  if (field.startsWith('addresses')) return 'addresses';
  if (field.startsWith('identifiers')) return 'identifiers';
  if (field.startsWith('documents')) return 'documents';
  if (field.startsWith('consents')) return 'review';
  return 'business';
}

const ACCEPTED_EXTENSIONS = /\.(pdf|jpe?g|png|webp)$/i;

/**
 * What is plainly wrong with a file before it is sent, or null.
 *
 * Name and emptiness only. The type a browser reports is a guess from the
 * extension, and the size ceiling is the operator's setting, so both are
 * left to the server - which decides from the file's own bytes whatever
 * this says.
 */
export function localFileProblem(file: File): TranslationKey | null {
  if (file.size === 0) return 'companyWizard.documents.emptyFile';
  if (!ACCEPTED_EXTENSIONS.test(file.name)) return 'companyWizard.documents.wrongType';
  return null;
}
