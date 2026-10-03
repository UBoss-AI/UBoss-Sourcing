/**
 * The signed-in buyer's own records for the universal search (ENH-004):
 * orders, invoices, shipments and requests for quotation that match a number,
 * reference, tracking code or title. Every query is scoped to this customer,
 * so another buyer's record is never found. Products, suppliers and help are
 * public and searched by the storefront with their own endpoints.
 */
import { prisma } from '../../infra/prisma.js';

const PER_KIND = 5;

export interface AccountSearchResult {
  orders: { id: string; orderNumber: string; status: string }[];
  invoices: { id: string; number: string; orderId: string }[];
  shipments: { id: string; trackingNumber: string; orderId: string; status: string }[];
  rfqs: { id: string; reference: string; title: string; status: string }[];
}

export async function searchAccount(customerProfileId: string, term: string): Promise<AccountSearchResult> {
  const q = term.trim().slice(0, 100);
  if (q.length < 2) return { orders: [], invoices: [], shipments: [], rfqs: [] };
  const mine = { customerProfileId };
  const [orders, invoices, shipments, rfqs] = await Promise.all([
    prisma.order.findMany({ where: { ...mine, orderNumber: { contains: q }, status: { not: 'DRAFT' } }, select: { id: true, orderNumber: true, status: true }, orderBy: { createdAt: 'desc' }, take: PER_KIND }),
    prisma.invoice.findMany({ where: { number: { contains: q }, order: mine }, select: { id: true, number: true, orderId: true }, orderBy: { createdAt: 'desc' }, take: PER_KIND }),
    prisma.shipment.findMany({ where: { trackingNumber: { contains: q }, order: mine }, select: { id: true, trackingNumber: true, orderId: true, status: true }, orderBy: { createdAt: 'desc' }, take: PER_KIND }),
    prisma.rfqRequest.findMany({ where: { ...mine, OR: [{ reference: { contains: q } }, { title: { contains: q } }] }, select: { id: true, reference: true, title: true, status: true }, orderBy: { createdAt: 'desc' }, take: PER_KIND }),
  ]);
  return {
    orders,
    invoices,
    shipments: shipments.map((s) => ({ ...s, trackingNumber: s.trackingNumber ?? '' })),
    rfqs,
  };
}

/** The buyer's open inspection jobs, soonest first, for the home task row (DYNAMIC-004). */
export async function openInspections(customerProfileId: string): Promise<{ jobNumber: string; status: string; scheduledFor: string; orderId: string; orderNumber: string }[]> {
  const orders = await prisma.order.findMany({ where: { customerProfileId, status: { not: 'DRAFT' } }, select: { id: true, orderNumber: true }, orderBy: { createdAt: 'desc' }, take: 200 });
  if (orders.length === 0) return [];
  const numbers = new Map(orders.map((o) => [o.id, o.orderNumber]));
  const requirements = await prisma.inspectionRequirement.findMany({ where: { orderId: { in: [...numbers.keys()] } }, select: { id: true, orderId: true } });
  if (requirements.length === 0) return [];
  const orderOf = new Map(requirements.map((r) => [r.id, r.orderId]));
  const jobs = await prisma.inspectionJob.findMany({
    where: { requirementId: { in: [...orderOf.keys()] }, status: { notIn: ['COMPLETED', 'CANCELLED', 'DECLINED'] } },
    select: { jobNumber: true, status: true, scheduledFor: true, requirementId: true },
    orderBy: [{ scheduledFor: 'asc' }, { jobNumber: 'asc' }],
    take: 5,
  });
  return jobs.map((job) => {
    const orderId = orderOf.get(job.requirementId) ?? '';
    return { jobNumber: job.jobNumber, status: job.status, scheduledFor: job.scheduledFor.toISOString(), orderId, orderNumber: numbers.get(orderId) ?? '' };
  });
}
