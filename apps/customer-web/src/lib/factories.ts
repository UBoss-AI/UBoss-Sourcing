/**
 * Seller Hub -> Factories and certificates (checklist Master row 13).
 *
 * A factory's status is the server's, never set here: the seller records the
 * plant, attaches evidence and sends it for review, and the marketplace's
 * reviewers decide. Evidence and certificate proofs are the seller's own
 * documents, uploaded through the same pipeline as the application's.
 */
import { api } from './api';
import { uploadSellerDocument, type SellerDocument } from './seller';

export type FactoryStatus = 'NOT_SUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
export type CertificationState = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

export interface FactoryEvidence {
  id: string;
  documentId: string;
  caption: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  createdAt: string;
  document: {
    originalFileName: string;
    kind: string;
    contentType: string;
    byteSize: number;
    scanState: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    isReplaced: boolean;
  } | null;
}

export interface FactoryMachine {
  id: string;
  name: string;
  quantity: number;
  capacityNote: string | null;
}

export interface Factory {
  id: string;
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  postcode: string;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
  establishedYear: number | null;
  floorAreaSqm: number | null;
  workforceCount: number | null;
  qcStaffCount: number | null;
  monthlyCapacity: number | null;
  capacityUnit: string | null;
  productsMade: string | null;
  qcProcess: string | null;
  machines: FactoryMachine[];
  evidence: FactoryEvidence[];
  verification: {
    status: FactoryStatus;
    checkId: string | null;
    reason: string | null;
    submittedAt: string | null;
    decidedAt: string | null;
    validUntil: string | null;
    isEditable: boolean;
  };
  history: { id: string; state: CertificationState; at: string; reason: string | null; validUntil: string | null }[];
  createdAt: string;
  updatedAt: string;
}

/** What the factory form sends. Empty optional fields go as null. */
export interface FactoryInput {
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  postcode: string;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
  establishedYear: number | null;
  floorAreaSqm: number | null;
  workforceCount: number | null;
  qcStaffCount: number | null;
  monthlyCapacity: number | null;
  capacityUnit: string | null;
  productsMade: string | null;
  qcProcess: string | null;
}

export interface Certification {
  id: string;
  factoryId: string | null;
  factoryName: string | null;
  standard: string;
  certificateNumber: string | null;
  issuer: string;
  scope: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  documentId: string | null;
  document: { originalFileName: string; contentType: string; byteSize: number; isReplaced: boolean } | null;
  state: CertificationState;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  rejectionReason: string | null;
  expiresSoon: boolean;
  isEditable: boolean;
  updatedAt: string;
}

export interface CertificationInput {
  standard: string;
  certificateNumber: string | null;
  issuer: string;
  scope: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  documentId: string;
  factoryId: string | null;
}

export function fetchFactories(): Promise<{ factories: Factory[] }> {
  return api.get<{ factories: Factory[] }>('/seller/factories');
}

export function createFactory(input: FactoryInput): Promise<{ factory: Factory }> {
  return api.post<{ factory: Factory }>('/seller/factories', input);
}

export function updateFactory(id: string, input: Partial<FactoryInput>): Promise<{ factory: Factory }> {
  return api.patch<{ factory: Factory }>(`/seller/factories/${id}`, input);
}

export function archiveFactory(id: string): Promise<never> {
  return api.delete<never>(`/seller/factories/${id}`);
}

export function saveMachines(
  id: string,
  machines: { name: string; quantity: number; capacityNote: string | null }[],
): Promise<{ factory: Factory }> {
  return api.put<{ factory: Factory }>(`/seller/factories/${id}/machines`, { machines });
}

export function addEvidence(
  id: string,
  input: { documentId: string; caption: string | null; capturedLatitude: number | null; capturedLongitude: number | null },
): Promise<{ factory: Factory }> {
  return api.post<{ factory: Factory }>(`/seller/factories/${id}/evidence`, input);
}

export function removeEvidence(id: string, evidenceId: string): Promise<{ factory: Factory }> {
  return api.delete<{ factory: Factory }>(`/seller/factories/${id}/evidence/${evidenceId}`);
}

export function submitFactory(id: string): Promise<{ factory: Factory }> {
  return api.post<{ factory: Factory }>(`/seller/factories/${id}/submit`);
}

export function fetchCertifications(): Promise<{ certifications: Certification[] }> {
  return api.get<{ certifications: Certification[] }>('/seller/certifications');
}

export function createCertification(input: CertificationInput): Promise<{ certification: Certification }> {
  return api.post<{ certification: Certification }>('/seller/certifications', input);
}

export function updateCertification(
  id: string,
  input: Partial<CertificationInput>,
): Promise<{ certification: Certification }> {
  return api.patch<{ certification: Certification }>(`/seller/certifications/${id}`, input);
}

export function archiveCertification(id: string): Promise<never> {
  return api.delete<never>(`/seller/certifications/${id}`);
}

export function submitCertification(id: string): Promise<{ certification: Certification }> {
  return api.post<{ certification: Certification }>(`/seller/certifications/${id}/submit`);
}

/**
 * Upload a file as evidence. Each upload gets its own requirement key, so a
 * second photograph never replaces the first - the document pipeline replaces
 * an older upload of the same kind that answers the same requirement.
 */
export function uploadEvidenceFile(file: File, purpose: 'factory' | 'certificate'): Promise<SellerDocument> {
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return uploadSellerDocument({
    file,
    kind: 'OTHER',
    requirementFieldKey: `${purpose}-evidence:${unique}`,
  });
}
