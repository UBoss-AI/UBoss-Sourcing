/**
 * The invoice for an order.
 *
 * Small on purpose. There are exactly three things a person does here — see
 * whether one has been raised, raise it, or reverse it — and every one of them
 * is irreversible in a way an ordinary admin screen is not.
 *
 * What the panel is careful to communicate:
 *
 *   - **Raising is idempotent, and the button says so implicitly by
 *     disappearing.** Two numbers against one supply is a real problem to
 *     unpick once both sit in a VAT return, so once an invoice exists the only
 *     action offered is the credit note.
 *
 *   - **There is no edit and no delete, and the panel does not imply there
 *     could be.** A gap in an invoice sequence reads to a tax inspector as a
 *     destroyed document. The original stands and a second document of equal
 *     and opposite value is issued against it.
 *
 *   - **The tax treatment is shown with its reason.** "Why is this order
 *     zero-rated" is the single most common question about a VAT engine, and
 *     an answer that requires reading the source is not an answer.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { ConfirmDialog } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, DescriptionList, LoadingState } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { ApiError, BASE_URL, api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

type TaxTreatment =
  | 'FLAT_RATE'
  | 'DOMESTIC'
  | 'INTRA_EU_REVERSE_CHARGE'
  | 'INTRA_EU_B2C'
  | 'EXPORT';

interface VatBreakdownRow {
  ratePercent: string;
  taxableMinor: string;
  vatMinor: string;
}

interface En16931Issue {
  /** The EN 16931 business rule or term this relates to. */
  rule: string;
  message: string;
}

interface Invoice {
  id: string;
  number: string;
  issuedAt: string;
  suppliedAt: string;
  sellerVatNumber: string | null;
  buyerVatNumber: string | null;
  taxTreatment: TaxTreatment;
  taxCountry: string | null;
  /** Art. 226(11) wording, frozen at issue. */
  exemptionNote: string | null;
  currency: string;
  vatBreakdown: VatBreakdownRow[];
  totals: {
    subtotalMinor: string;
    discountMinor: string;
    taxMinor: string;
    shippingMinor: string;
    grandTotalMinor: string;
  };
  creditsInvoiceId: string | null;
  isCreditNote: boolean;
}

const TREATMENT_TONE: Record<TaxTreatment, BadgeTone> = {
  FLAT_RATE: 'neutral',
  DOMESTIC: 'neutral',
  INTRA_EU_REVERSE_CHARGE: 'operational',
  INTRA_EU_B2C: 'accent',
  EXPORT: 'operational',
};

/** Minor units to a readable amount. The API sends strings; BigInt keeps them exact. */
function money(minor: string, currency: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;

  const units = absolute / 100n;
  const cents = absolute % 100n;

  return `${negative ? '-' : ''}${currency} ${units.toString()}.${cents.toString().padStart(2, '0')}`;
}

export function InvoicePanel({ orderId }: { orderId: string }): React.JSX.Element {
  const { t } = useI18n();

  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [confirmCredit, setConfirmCredit] = useState(false);

  const canIssue = can(Permission.INVOICE_ISSUE);

  const query = useQuery({
    queryKey: ['order-invoice', orderId],
    queryFn: () => api.get<{ invoice: Invoice | null }>(`/admin/orders/${orderId}/invoice`),
  });

  const invoiceId = query.data?.invoice?.id ?? null;

  /**
   * What a receiver's validator would object to.
   *
   * Fetched alongside the invoice rather than behind a button: an operator
   * about to send a document electronically should not have to know to ask.
   */
  const check = useQuery({
    queryKey: ['invoice-en16931', invoiceId],
    queryFn: () =>
      api.get<{ ok: boolean; issues: En16931Issue[] }>(
        `/admin/invoices/${String(invoiceId)}/en16931-check`,
      ),
    enabled: invoiceId !== null,
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['order-invoice', orderId] });
  };

  const issue = useMutation({
    mutationFn: () => api.post(`/admin/orders/${orderId}/invoice`),
    onSuccess: async () => {
      toast.success(t('invoice.issued'));
      await invalidate();
    },
    onError: (error) => {
      // The API refuses an order that was never supplied, and says why.
      toast.error(error instanceof ApiError ? error.message : t('invoice.couldNotIssue'));
    },
  });

  const credit = useMutation({
    mutationFn: (invoiceId: string) => api.post(`/admin/invoices/${invoiceId}/credit`),
    onSuccess: async () => {
      toast.success(t('invoice.credited'));
      setConfirmCredit(false);
      await invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t('invoice.couldNotCredit'));
      setConfirmCredit(false);
    },
  });

  if (query.isPending) {
    return (
      <Card title={t('invoice.title')}>
        <LoadingState label={t('invoice.loading')} />
      </Card>
    );
  }

  const invoice = query.data?.invoice ?? null;

  if (invoice === null) {
    return (
      <Card title={t('invoice.title')}>
        <div className="space-y-3 px-5 py-4">
          <p className="text-sm text-ink-muted">{t('invoice.notIssued')}</p>

          {canIssue ? (
            <Button
              variant="primary"
              isLoading={issue.isPending}
              onClick={() => {
                issue.mutate();
              }}
            >
              {t('invoice.issue')}
            </Button>
          ) : (
            <p className="text-xs text-ink-subtle">{t('invoice.noPermission')}</p>
          )}
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card title={t('invoice.title')}>
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold text-ink">{invoice.number}</span>
            <Badge tone={TREATMENT_TONE[invoice.taxTreatment]}>
              {t(`invoice.treatment.${invoice.taxTreatment}` as 'invoice.treatment.DOMESTIC')}
            </Badge>
            {invoice.taxCountry !== null && <Badge tone="neutral">{invoice.taxCountry}</Badge>}
          </div>

          <DescriptionList
            items={[
              { label: t('invoice.issuedAt'), value: formatDateTime(invoice.issuedAt) },
              // Art. 226(7): the date of supply, which is not always the date
              // of issue and can fall in a different VAT period.
              { label: t('invoice.suppliedAt'), value: formatDateTime(invoice.suppliedAt) },
              { label: t('invoice.sellerVat'), value: invoice.sellerVatNumber ?? '—' },
              { label: t('invoice.buyerVat'), value: invoice.buyerVatNumber ?? '—' },
            ]}
          />

          {/* Art. 226(11). Shown verbatim, because this exact wording is what
              was issued and what a tax inspector reads. */}
          {invoice.exemptionNote !== null && (
            <Callout tone="neutral" title={t('invoice.exemptionTitle')}>
              {invoice.exemptionNote}
            </Callout>
          )}

          {/* Art. 226(8)-(10): the taxable amount and the tax, per rate. One
              combined figure is not a valid invoice, however correct it is. */}
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
              {t('invoice.vatBreakdown')}
            </h3>

            <table className="mt-2 w-full text-sm">
              <caption className="sr-only">{t('invoice.vatBreakdown')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xxs uppercase tracking-wide text-ink-subtle">
                  <th scope="col" className="py-1">
                    {t('invoice.rate')}
                  </th>
                  <th scope="col" className="py-1 text-right">
                    {t('invoice.taxable')}
                  </th>
                  <th scope="col" className="py-1 text-right">
                    {t('invoice.vat')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoice.vatBreakdown.map((row) => (
                  <tr key={row.ratePercent} className="border-b border-border-subtle">
                    <td className="py-1.5 text-ink">{Number(row.ratePercent)}%</td>
                    <td className="py-1.5 text-right tabular-nums text-ink-muted">
                      {money(row.taxableMinor, invoice.currency)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-ink">
                      {money(row.vatMinor, invoice.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-baseline justify-between border-t border-border pt-3">
            <span className="text-sm font-medium text-ink">{t('invoice.total')}</span>
            <span className="tabular-nums text-sm font-semibold text-ink">
              {money(invoice.totals.grandTotalMinor, invoice.currency)}
            </span>
          </div>

          {invoice.isCreditNote && (
            <Callout tone="warning">{t('invoice.isCreditNote')}</Callout>
          )}

          {/* The electronic document. Italy requires one today; Germany,
              France, Poland and Belgium are phasing theirs in. Downloading it
              by hand is the path before an access point contract exists, and
              the same bytes are what an AP integration would send. */}
          <div className="border-t border-border pt-3">
            {check.data !== undefined && !check.data.ok && (
              <Callout tone="warning" title={t('invoice.en16931Title')}>
                <ul className="list-disc space-y-1 pl-5">
                  {check.data.issues.map((issue) => (
                    <li key={issue.rule}>
                      <span className="font-mono text-xxs">{issue.rule}</span> — {issue.message}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}

            <a
              className="mt-2 inline-flex items-center text-sm font-semibold text-ink underline underline-offset-2 hover:no-underline"
              href={`${BASE_URL}/admin/invoices/${invoice.id}/ubl`}
              download
            >
              {t('invoice.downloadUbl')}
            </a>
            <p className="mt-1 text-xxs text-ink-subtle">{t('invoice.ublHint')}</p>
          </div>

          {canIssue && !invoice.isCreditNote && (
            <div className="border-t border-border pt-3">
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmCredit(true);
                }}
              >
                {t('invoice.credit')}
              </Button>
              {/* Said next to the button rather than only in the dialog: the
                  absence of an Edit and a Delete is a deliberate design, and a
                  reader who does not know that will go looking for them. */}
              <p className="mt-2 text-xxs text-ink-subtle">{t('invoice.noEditHint')}</p>
            </div>
          )}
        </div>
      </Card>

      <ConfirmDialog
        isOpen={confirmCredit}
        title={t('invoice.creditTitle')}
        body={t('invoice.creditBody', { number: invoice.number })}
        confirmLabel={t('invoice.credit')}
        isDangerous
        isWorking={credit.isPending}
        onClose={() => {
          setConfirmCredit(false);
        }}
        onConfirm={() => {
          credit.mutate(invoice.id);
        }}
      />
    </>
  );
}
