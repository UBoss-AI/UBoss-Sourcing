/**
 * Payment and refund receipts on the buyer's own orders.
 *
 * A receipt exists for every captured payment and every refund the provider
 * confirmed. The number is issued by the server the first time it is
 * downloaded, so `receiptNumber` is null on one nobody has opened yet.
 */
import { ApiError, api, type ApiErrorBody } from './api';
import type { Money } from './format';
import { resolveApiUrl } from './seller-documents';

export interface OrderReceipt {
  kind: 'payment' | 'refund';
  sourceId: string;
  amount: Money;
  occurredAt: string | null;
  receiptNumber: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
}

export function fetchOrderReceipts(orderId: string): Promise<{ receipts: OrderReceipt[] }> {
  return api.get(`/orders/${orderId}/receipts`);
}

/**
 * Fetch the PDF with the session cookie and save it.
 *
 * Fetched rather than navigated to: in development the API sits on another
 * port, and a refusal must come back as a sentence on this page.
 */
export async function downloadReceipt(
  orderId: string,
  receipt: Pick<OrderReceipt, 'kind' | 'sourceId'>,
  language: string,
): Promise<void> {
  const path = `/api/v1/orders/${orderId}/receipts/${receipt.kind}/${receipt.sourceId}?lang=${encodeURIComponent(language)}`;
  const response = await fetch(resolveApiUrl(path), { credentials: 'include' });
  if (!response.ok) {
    let body: { error?: ApiErrorBody } | null = null;
    try {
      body = (await response.json()) as { error?: ApiErrorBody };
    } catch {
      body = null;
    }
    throw new ApiError(
      response.status,
      body?.error ?? { code: 'UNEXPECTED_RESPONSE', message: `HTTP ${String(response.status)}` },
    );
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? 'receipt.pdf';
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}
