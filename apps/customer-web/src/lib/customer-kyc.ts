/**
 * An individual buyer's identity check, importer details and marketing
 * choices, as this app calls them (checklist Master row 11).
 *
 * Everything is the signed-in buyer's own: the server keys each call by the
 * session, never by an id in the URL.
 */
import { api, postFile } from './api';

export type KycStatus = 'NOT_STARTED' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
export type KycDocumentKind = 'IDENTITY' | 'PROOF_OF_ADDRESS' | 'IMPORT_LICENCE' | 'TAX_REGISTRATION' | 'OTHER';
export type IdDocumentType = 'PASSPORT' | 'NATIONAL_ID' | 'DRIVING_LICENCE';

export const KYC_DOCUMENT_KINDS: readonly KycDocumentKind[] = [
  'IDENTITY',
  'PROOF_OF_ADDRESS',
  'IMPORT_LICENCE',
  'TAX_REGISTRATION',
  'OTHER',
];
export const ID_DOCUMENT_TYPES: readonly IdDocumentType[] = ['PASSPORT', 'NATIONAL_ID', 'DRIVING_LICENCE'];
export const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const;

export interface KycIdentity {
  legalName: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  residenceCountry: string | null;
  idDocumentType: IdDocumentType | null;
  /** Only ever the last characters; the whole number never comes back. */
  idDocumentNumberMasked: string | null;
  idDocumentExpiresOn: string | null;
}

export interface KycImporter {
  isImporter: boolean;
  importerName: string | null;
  eoriNumber: string | null;
  importerTaxId: string | null;
  importLicenceNumber: string | null;
  customsBrokerName: string | null;
  customsBrokerEmail: string | null;
  preferredIncoterm: string | null;
}

export interface KycDocument {
  id: string;
  kind: KycDocumentKind;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  reviewNote: string | null;
  createdAt: string;
}

export interface Kyc {
  status: KycStatus;
  editable: boolean;
  identity: KycIdentity;
  importer: KycImporter;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  documents: KycDocument[];
}

export interface MarketingChoices {
  marketingEmailOptIn: boolean;
  marketingSmsOptIn: boolean;
  productNewsOptIn: boolean;
  marketingUpdatedAt: string | null;
}

export type IdentityDraft = Omit<KycIdentity, 'idDocumentNumberMasked'> & { idDocumentNumber?: string };

export const kycKeys = {
  kyc: ['account', 'kyc'] as const,
  marketing: ['account', 'preferences', 'marketing'] as const,
};

export const kycApi = {
  get: () => api.get<Kyc>('/account/kyc'),
  saveIdentity: (draft: IdentityDraft) => api.put<Kyc>('/account/kyc/identity', draft),
  saveImporter: (draft: KycImporter) => api.put<Kyc>('/account/kyc/importer', draft),
  submit: () => api.post<Kyc>('/account/kyc/submit'),
  /** The `kind` field goes before the file: the server reads fields in order. */
  upload: (kind: KycDocumentKind, file: File) => {
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', file);
    return postFile<Kyc>('/account/kyc/documents', form);
  },
  withdraw: (id: string) => api.delete<Kyc>(`/account/kyc/documents/${id}`),
  marketing: () => api.get<MarketingChoices>('/account/preferences/marketing'),
  saveMarketing: (choices: Omit<MarketingChoices, 'marketingUpdatedAt'>) =>
    api.put<MarketingChoices>('/account/preferences/marketing', choices),
};
