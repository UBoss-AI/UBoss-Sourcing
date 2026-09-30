import { api } from './api';
import type { Money } from './format';

export interface RfqPoContract {
  schemaVersion: 1;
  rfq: { id: string; reference: string; requirementVersion: number };
  quote: { id: string; versionId: string; versionNumber: number; acceptedTermsHash: string; acceptedAt: string };
  buyer: { kind: 'INDIVIDUAL' | 'COMPANY'; companyId: string | null };
  supplier: { sellerAccountId: string; name: string };
  item: {
    buyerSku: string | null;
    title: string;
    specification: string | null;
    specifications: { key: string; value: string }[];
    quantity: string;
    unitOfMeasure: string | null;
  };
  delivery: {
    destinationCountry: string | null;
    destinationAddress: string | null;
    destinationPort: string | null;
    targetDate: string | null;
    leadTimeDays: number | null;
    incoterm: string | null;
    incotermPlace: string | null;
  };
  commercial: {
    currency: string;
    unitPriceMinor: string;
    applicableUnitPriceMinor: string;
    quantity: string;
    moq: string | null;
    leadTimeDays: number | null;
    incoterm: string | null;
    incotermPlace: string | null;
    paymentTerms: string | null;
    inspectionTerms: string | null;
    warranty: string | null;
    sampleCostMinor: string | null;
    shippingEstimateMinor: string | null;
    taxesDisclosure: string | null;
    goodsTotalMinor: string;
    toolingMinor: string;
    shippingMinor: string;
    grandTotalMinor: string;
  };
  quality: {
    certifications: string[];
    inspectionRequirement: string;
    inspectionTerms: string | null;
    sampleRequirement: string;
    warranty: string | null;
  };
  documents: { id: string; fileName: string; contentHash: string }[];
}

interface Amounts {
  currency: string;
  goods: Money;
  tooling: Money;
  shipping: Money;
  grand: Money;
}

export interface RfqPoPreview {
  acceptedTermsHash: string;
  contractHash: string;
  contract: RfqPoContract;
  amounts: Amounts;
  actions: { canSubmit: true; canApprove: false; canReject: false };
}

export interface RfqPurchaseOrder {
  id: string;
  reference: string;
  rfqId: string;
  quoteId: string;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  version: number;
  acceptedTermsHash: string;
  contractHash: string;
  contract: RfqPoContract;
  buyerSku: string | null;
  amounts: Amounts;
  electronicAcceptance: { acceptedAt: string; signatureName: string; signatureTitle: string | null };
  approvals: {
    stage: 'APPROVER' | 'FINANCE';
    decision: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
    decidedAt: string | null;
    reason: string | null;
  }[];
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  actions: { canSubmit: false; canApprove: boolean; canReject: boolean };
}

export type RfqPoReview =
  | { kind: 'PREVIEW'; preview: RfqPoPreview }
  | { kind: 'PURCHASE_ORDER'; purchaseOrder: RfqPurchaseOrder };

export async function fetchRfqPoReview(rfqId: string): Promise<RfqPoReview> {
  return api.get(`/rfqs/${rfqId}/purchase-order`);
}

export async function submitRfqPurchaseOrder(
  rfqId: string,
  input: { acceptedTermsHash: string; eAccepted: true; signatureName: string; signatureTitle: string | null; buyerSku: string | null },
): Promise<RfqPurchaseOrder> {
  return (await api.post<{ purchaseOrder: RfqPurchaseOrder }>(`/rfqs/${rfqId}/purchase-order`, input)).purchaseOrder;
}

export async function decideRfqPurchaseOrder(
  rfqId: string,
  input: { expectedVersion: number; approved: boolean; reason: string | null },
): Promise<RfqPurchaseOrder> {
  return (await api.post<{ purchaseOrder: RfqPurchaseOrder }>(`/rfqs/${rfqId}/purchase-order/decision`, input)).purchaseOrder;
}
