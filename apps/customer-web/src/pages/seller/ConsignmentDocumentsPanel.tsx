/**
 * Invoices and packing lists, per consignment, on the seller's order page.
 *
 * The order of work is the order of the page: say what is in each package,
 * check the invoice, then press Mark packed - which issues the invoice and the
 * packing list together, or neither. Every figure and every "this cannot be
 * issued yet" comes from the server; this screen only shows it and translates
 * the checklist.
 *
 * An issued invoice is never edited here. The one way to correct it is a
 * credit note, which gets a number of its own, and the page says so where the
 * seller would otherwise look for an Edit button.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Select,
  Textarea,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import {
  creditInvoice,
  draftPdfUrl,
  fetchSellerOrderDocuments,
  gramsToKg,
  issueKey,
  issueInvoice,
  issuePackingList,
  downloadWith,
  packConsignment,
  previewInvoice,
  previewPackingList,
  savePackages,
  sellerBatchLink,
  sellerDocumentLink,
  splitConsignment,
  statusTone,
  supersedePackingList,
  type ConsignmentDocuments,
  type DocumentIssue,
  type DocumentKind,
  type PackageInput,
  type SellerDocumentStatus,
} from '@/lib/seller-documents';

const PACKAGING_TYPES = ['Carton', 'Pallet', 'Crate', 'Drum', 'Bag', 'Container'] as const;

function queryKey(sellerOrderId: string): readonly unknown[] {
  return ['seller', 'order', sellerOrderId, 'documents'];
}

export function ConsignmentDocumentsPanel({
  sellerOrderId,
  canAct,
}: {
  sellerOrderId: string;
  canAct: boolean;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const query = useQuery({
    queryKey: queryKey(sellerOrderId),
    queryFn: () => fetchSellerOrderDocuments(sellerOrderId),
  });

  const issued = (query.data?.consignments ?? []).flatMap((consignment) => [
    ...consignment.invoices
      .filter((invoice) => invoice.number !== null)
      .map((invoice) => ({ kind: 'invoice' as const, id: invoice.id })),
    ...consignment.packingLists
      .filter((list) => list.number !== null)
      .map((list) => ({ kind: 'packing-list' as const, id: list.id })),
  ]);

  const batch = useMutation({
    mutationFn: () => downloadWith(() => sellerBatchLink(issued)),
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  if (query.isPending) return <LoadingState label={t('sellerDocs.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  if (query.data.consignments.length === 0) return null;

  return (
    <Card
      title={t('sellerDocs.heading')}
      description={t('sellerDocs.intro')}
      actions={
        issued.length > 1 ? (
          <Button
            size="sm"
            isLoading={batch.isPending}
            onClick={() => {
              batch.mutate();
            }}
          >
            {t('sellerDocs.downloadAll', { quantity: issued.length })}
          </Button>
        ) : undefined
      }
    >
      <div className="divide-y divide-border-subtle">
        {query.data.consignments.map((consignment) => (
          <ConsignmentBlock
            key={consignment.id}
            sellerOrderId={sellerOrderId}
            consignment={consignment}
            canAct={canAct}
          />
        ))}
      </div>
    </Card>
  );
}

function ConsignmentBlock({
  sellerOrderId,
  consignment,
  canAct,
}: {
  sellerOrderId: string;
  consignment: ConsignmentDocuments;
  canAct: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [dialog, setDialog] = useState<'packages' | 'split' | 'credit' | 'supersede' | null>(null);
  const [issues, setIssues] = useState<{ kind: DocumentKind; list: DocumentIssue[] } | null>(null);

  const refresh = (): Promise<void> =>
    client.invalidateQueries({ queryKey: queryKey(sellerOrderId) });

  const liveInvoice =
    [...consignment.invoices]
      .reverse()
      .find((invoice) => invoice.kind === 'TAX_INVOICE' && invoice.status !== 'SUPERSEDED') ?? null;
  const creditNotes = consignment.invoices.filter((invoice) => invoice.kind === 'CREDIT_NOTE');
  const liveList =
    [...consignment.packingLists].reverse().find((list) => list.status !== 'SUPERSEDED') ?? null;
  const packed = consignment.packedAt !== null;
  const invoiceIssued = liveInvoice?.number != null && liveInvoice.status === 'ISSUED';
  const listIssued = liveList?.status === 'ISSUED';
  const totalPieces = consignment.lines.reduce((sum, line) => sum + line.quantity, 0);

  const onFailure = (kind: DocumentKind) => (error: unknown) => {
    toast.error(errorMessage(t, error));
    void refresh();
    const details = (error as { details?: DocumentIssue[] }).details;
    if (Array.isArray(details) && details.length > 0) setIssues({ kind, list: details });
  };

  const checkInvoice = useMutation({
    mutationFn: () => previewInvoice(consignment.id),
    onSuccess: async ({ invoice }) => {
      setIssues({ kind: 'invoice', list: invoice.validation ?? [] });
      await refresh();
    },
    onError: onFailure('invoice'),
  });
  const checkList = useMutation({
    mutationFn: () => previewPackingList(consignment.id),
    onSuccess: async ({ packingList }) => {
      setIssues({ kind: 'packing-list', list: packingList.validation ?? [] });
      await refresh();
    },
    onError: onFailure('packing-list'),
  });
  const issueInv = useMutation({
    mutationFn: () => issueInvoice(consignment.id),
    onSuccess: async ({ invoice }) => {
      toast.success(t('sellerDocs.invoiceIssued', { number: invoice.number ?? '' }));
      setIssues(null);
      await refresh();
    },
    onError: onFailure('invoice'),
  });
  const issueList = useMutation({
    mutationFn: () => issuePackingList(consignment.id),
    onSuccess: async ({ packingList }) => {
      toast.success(t('sellerDocs.packingListIssued', { number: packingList.number ?? '' }));
      setIssues(null);
      await refresh();
    },
    onError: onFailure('packing-list'),
  });
  const pack = useMutation({
    mutationFn: () => packConsignment(consignment.id),
    onSuccess: async () => {
      toast.success(t('sellerDocs.packedDone'));
      setIssues(null);
      await refresh();
    },
    onError: onFailure('invoice'),
  });
  const download = useMutation({
    mutationFn: ({ kind, id }: { kind: DocumentKind; id: string }) =>
      downloadWith(() => sellerDocumentLink(kind, id)),
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const busy =
    checkInvoice.isPending ||
    checkList.isPending ||
    issueInv.isPending ||
    issueList.isPending ||
    pack.isPending;

  return (
    <section className="space-y-4 px-6 py-5" aria-labelledby={`consignment-${consignment.id}`}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id={`consignment-${consignment.id}`} className="text-sm font-semibold text-ink">
            {consignment.shipmentReference}
          </h3>
          <p className="text-xs text-ink-muted">
            {t('sellerDocs.carries', { quantity: totalPieces, lines: consignment.lines.length })}
            {consignment.splitFromShipmentId !== null && ` · ${t('sellerDocs.splitPart')}`}
          </p>
        </div>
        <Badge tone={packed ? 'success' : 'neutral'}>
          {packed
            ? t('sellerDocs.packedOn', {
                when: new Date(consignment.packedAt ?? '').toLocaleString(),
              })
            : t('sellerDocs.notPacked')}
        </Badge>
      </header>

      {liveInvoice?.status === 'CREDIT_NOTE_REQUIRED' && (
        <p
          role="alert"
          className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-ink"
        >
          {t('sellerDocs.creditNoteRequired', { number: liveInvoice.number ?? '' })}
        </p>
      )}

      {/* What goes where */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            {t('sellerDocs.packages')}
          </h4>
          {canAct && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={consignment.packagesLocked !== null}
                onClick={() => {
                  setDialog('packages');
                }}
              >
                {consignment.packages.length === 0
                  ? t('sellerDocs.addPackages')
                  : t('sellerDocs.editPackages')}
              </Button>
              {!packed && !invoiceIssued && totalPieces > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDialog('split');
                  }}
                >
                  {t('sellerDocs.split')}
                </Button>
              )}
            </div>
          )}
        </div>
        {consignment.packagesLocked !== null && (
          <p className="text-xs text-ink-muted">
            {t(`sellerDocs.lock.${consignment.packagesLocked}` as TranslationKey)}
          </p>
        )}
        {consignment.packages.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('sellerDocs.noPackages')}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {consignment.packages.map((pkg) => (
              <li
                key={pkg.id}
                className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-2 text-sm"
              >
                <p className="font-medium text-ink">
                  {pkg.reference} · {pkg.packagingType ?? t('sellerDocs.package')}
                </p>
                <p className="text-xs text-ink-muted">
                  {pkg.lengthMm !== null && pkg.widthMm !== null && pkg.heightMm !== null
                    ? `${String(pkg.lengthMm)} × ${String(pkg.widthMm)} × ${String(pkg.heightMm)} mm · `
                    : ''}
                  {t('sellerDocs.grossKg', { kg: gramsToKg(pkg.grossWeightGrams) })}
                </p>
                <ul className="mt-1 text-xs text-ink">
                  {pkg.contents.map((content) => {
                    const line = consignment.lines.find(
                      (entry) => entry.orderItemId === content.orderItemId,
                    );
                    return (
                      <li key={`${content.orderItemId}-${content.batchNumber}`}>
                        {line?.sku ?? ''} × {content.quantity.toLocaleString()}
                        {content.batchNumber !== '' &&
                          ` · ${t('sellerDocs.batch')} ${content.batchNumber}`}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The two documents */}
      <div className="grid gap-3 sm:grid-cols-2">
        <DocumentRow
          title={t('sellerDocs.invoice')}
          number={liveInvoice?.number ?? null}
          status={liveInvoice?.status ?? null}
          summary={
            liveInvoice === null
              ? null
              : t('sellerDocs.invoiceTotal', { total: liveInvoice.totals.grandTotal.formatted })
          }
        >
          {invoiceIssued || liveInvoice?.status === 'CREDIT_NOTE_REQUIRED' ? (
            <>
              <Button
                size="sm"
                onClick={() => {
                  download.mutate({ kind: 'invoice', id: liveInvoice.id });
                }}
              >
                {t('sellerDocs.download')}
              </Button>
              {canAct && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDialog('credit');
                  }}
                >
                  {t('sellerDocs.creditNote')}
                </Button>
              )}
            </>
          ) : (
            canAct && (
              <>
                <Button
                  size="sm"
                  isLoading={checkInvoice.isPending}
                  disabled={busy}
                  onClick={() => {
                    checkInvoice.mutate();
                  }}
                >
                  {t('sellerDocs.check')}
                </Button>
                <a
                  className="inline-flex items-center rounded-md px-2 text-sm text-brand hover:underline"
                  href={draftPdfUrl(consignment.id, 'invoice')}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('sellerDocs.previewPdf')}
                </a>
                <Button
                  size="sm"
                  variant="ghost"
                  isLoading={issueInv.isPending}
                  disabled={busy || liveInvoice?.status !== 'READY_TO_ISSUE'}
                  onClick={() => {
                    issueInv.mutate();
                  }}
                >
                  {t('sellerDocs.issueInvoice')}
                </Button>
              </>
            )
          )}
        </DocumentRow>

        <DocumentRow
          title={t('sellerDocs.packingList')}
          number={liveList?.number ?? null}
          status={liveList?.status ?? null}
          summary={
            liveList === null
              ? null
              : t('sellerDocs.listSummary', {
                  packages: liveList.packageCount,
                  quantity: liveList.totalBaseUnits,
                  kg: gramsToKg(liveList.grossWeightGrams),
                })
          }
        >
          {listIssued ? (
            <>
              <Button
                size="sm"
                onClick={() => {
                  download.mutate({ kind: 'packing-list', id: liveList.id });
                }}
              >
                {t('sellerDocs.download')}
              </Button>
              {canAct && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDialog('supersede');
                  }}
                >
                  {t('sellerDocs.supersede')}
                </Button>
              )}
            </>
          ) : (
            canAct && (
              <>
                <Button
                  size="sm"
                  isLoading={checkList.isPending}
                  disabled={busy}
                  onClick={() => {
                    checkList.mutate();
                  }}
                >
                  {t('sellerDocs.check')}
                </Button>
                <a
                  className="inline-flex items-center rounded-md px-2 text-sm text-brand hover:underline"
                  href={draftPdfUrl(consignment.id, 'packing-list')}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('sellerDocs.previewPdf')}
                </a>
                <Button
                  size="sm"
                  variant="ghost"
                  isLoading={issueList.isPending}
                  disabled={busy || liveList?.status !== 'READY_TO_ISSUE'}
                  onClick={() => {
                    issueList.mutate();
                  }}
                >
                  {t('sellerDocs.issuePackingList')}
                </Button>
              </>
            )
          )}
        </DocumentRow>
      </div>

      {creditNotes.length > 0 && (
        <ul className="space-y-1 text-sm">
          {creditNotes.map((note) => (
            <li key={note.id} className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{t('sellerDocs.creditNoteLabel')}</Badge>
              <span className="font-medium text-ink">{note.number}</span>
              <span className="text-ink-muted">{note.totals.grandTotal.formatted}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  download.mutate({ kind: 'invoice', id: note.id });
                }}
              >
                {t('sellerDocs.download')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {issues !== null && <IssueList kind={issues.kind} issues={issues.list} />}

      {canAct && !packed && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle pt-4">
          <Button
            variant="primary"
            isLoading={pack.isPending}
            disabled={busy || consignment.packages.length === 0}
            onClick={() => {
              pack.mutate();
            }}
          >
            {t('sellerDocs.markPacked')}
          </Button>
          <p className="max-w-prose text-xs text-ink-muted">{t('sellerDocs.markPackedHint')}</p>
        </div>
      )}

      {dialog === 'packages' && (
        <PackagesDialog
          consignment={consignment}
          onClose={() => {
            setDialog(null);
          }}
          onSaved={async () => {
            setDialog(null);
            setIssues(null);
            await refresh();
          }}
        />
      )}
      {dialog === 'split' && (
        <SplitDialog
          consignment={consignment}
          onClose={() => {
            setDialog(null);
          }}
          onSaved={async (reference) => {
            setDialog(null);
            toast.success(t('sellerDocs.splitDone', { reference }));
            await refresh();
          }}
        />
      )}
      {dialog === 'credit' && liveInvoice !== null && (
        <ReasonDialog
          title={t('sellerDocs.creditTitle', { number: liveInvoice.number ?? '' })}
          description={t('sellerDocs.creditIntro')}
          confirm={t('sellerDocs.creditConfirm')}
          action={(reason) => creditInvoice(liveInvoice.id, reason)}
          onClose={() => {
            setDialog(null);
          }}
          onDone={async () => {
            setDialog(null);
            toast.success(t('sellerDocs.creditDone'));
            await refresh();
          }}
        />
      )}
      {dialog === 'supersede' && liveList !== null && (
        <ReasonDialog
          title={t('sellerDocs.supersedeTitle', { number: liveList.number ?? '' })}
          description={t('sellerDocs.supersedeIntro')}
          confirm={t('sellerDocs.supersedeConfirm')}
          action={(reason) => supersedePackingList(consignment.id, reason)}
          onClose={() => {
            setDialog(null);
          }}
          onDone={async () => {
            setDialog(null);
            await refresh();
          }}
        />
      )}
    </section>
  );
}

function DocumentRow({
  title,
  number,
  status,
  summary,
  children,
}: {
  title: string;
  number: string | null;
  status: SellerDocumentStatus | null;
  summary: string | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="space-y-2 rounded-md border border-border-subtle px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">
          {title}
          {number !== null && (
            <span className="ml-2 font-mono text-xs text-ink-muted">{number}</span>
          )}
        </p>
        <Badge tone={status === null ? 'neutral' : statusTone(status)}>
          {t(`sellerDocs.status.${status ?? 'NONE'}` as TranslationKey)}
        </Badge>
      </div>
      {summary !== null && <p className="text-xs text-ink-muted">{summary}</p>}
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** The server's checklist, in the reader's language. */
function IssueList({
  kind,
  issues,
}: {
  kind: DocumentKind;
  issues: DocumentIssue[];
}): React.JSX.Element {
  const { t } = useI18n();
  const { i18n } = useTranslation();
  if (issues.length === 0) {
    return (
      <p
        role="status"
        className="rounded-md border border-success/30 bg-success-soft px-3 py-2 text-sm text-ink"
      >
        {kind === 'invoice' ? t('sellerDocs.invoiceReady') : t('sellerDocs.listReady')}
      </p>
    );
  }
  return (
    <div
      role="alert"
      className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-ink"
    >
      <p className="font-medium">{t('sellerDocs.fixFirst')}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {issues.map((issue, index) => {
          const key = issueKey(issue);
          // A code this build does not know yet still says something useful.
          const text = i18n.exists(key)
            ? t(key as TranslationKey, { ...(issue.meta ?? {}) })
            : (issue.message ?? key);
          return <li key={`${issue.field ?? ''}-${String(index)}`}>{text}</li>;
        })}
      </ul>
    </div>
  );
}

interface DraftPackage {
  packagingType: string;
  lengthMm: string;
  widthMm: string;
  heightMm: string;
  grossKg: string;
  netKg: string;
  containerNumber: string;
  sealNumber: string;
  contents: { orderItemId: string; quantity: string; batchNumber: string; expiryDate: string }[];
}

function toDraft(consignment: ConsignmentDocuments): DraftPackage[] {
  if (consignment.packages.length > 0) {
    return consignment.packages.map((pkg) => ({
      packagingType: pkg.packagingType ?? 'Carton',
      lengthMm: pkg.lengthMm?.toString() ?? '',
      widthMm: pkg.widthMm?.toString() ?? '',
      heightMm: pkg.heightMm?.toString() ?? '',
      grossKg: pkg.grossWeightGrams > 0 ? String(pkg.grossWeightGrams / 1000) : '',
      netKg: pkg.netWeightGrams === null ? '' : String(pkg.netWeightGrams / 1000),
      containerNumber: pkg.containerNumber ?? '',
      sealNumber: pkg.sealNumber ?? '',
      contents: pkg.contents.map((content) => ({
        orderItemId: content.orderItemId,
        quantity: String(content.quantity),
        batchNumber: content.batchNumber,
        expiryDate: content.expiryDate ?? '',
      })),
    }));
  }
  // One package holding everything is where most sellers start.
  return [
    {
      packagingType: 'Carton',
      lengthMm: '',
      widthMm: '',
      heightMm: '',
      grossKg: '',
      netKg: '',
      containerNumber: '',
      sealNumber: '',
      contents: consignment.lines.map((line) => ({
        orderItemId: line.orderItemId,
        quantity: String(line.quantity),
        batchNumber: '',
        expiryDate: '',
      })),
    },
  ];
}

const wholeOrNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
};

/** Kilograms typed by a person, as whole grams. Weight, not money. */
const gramsOrNull = (kg: string): number | null => {
  const trimmed = kg.trim().replace(',', '.');
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : null;
};

function PackagesDialog({
  consignment,
  onClose,
  onSaved,
}: {
  consignment: ConsignmentDocuments;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [packages, setPackages] = useState<DraftPackage[]>(() => toDraft(consignment));

  const packedBy = new Map<string, number>();
  for (const pkg of packages) {
    for (const content of pkg.contents) {
      packedBy.set(
        content.orderItemId,
        (packedBy.get(content.orderItemId) ?? 0) + (wholeOrNull(content.quantity) ?? 0),
      );
    }
  }

  const save = useMutation({
    mutationFn: () => {
      const input: PackageInput[] = packages.map((pkg) => ({
        packagingType: pkg.packagingType,
        lengthMm: wholeOrNull(pkg.lengthMm),
        widthMm: wholeOrNull(pkg.widthMm),
        heightMm: wholeOrNull(pkg.heightMm),
        grossWeightGrams: gramsOrNull(pkg.grossKg) ?? 0,
        netWeightGrams: gramsOrNull(pkg.netKg),
        containerNumber: pkg.containerNumber.trim() === '' ? null : pkg.containerNumber.trim(),
        sealNumber: pkg.sealNumber.trim() === '' ? null : pkg.sealNumber.trim(),
        contents: pkg.contents
          .filter((content) => (wholeOrNull(content.quantity) ?? 0) > 0)
          .map((content) => ({
            orderItemId: content.orderItemId,
            quantity: wholeOrNull(content.quantity) ?? 0,
            batchNumber: content.batchNumber.trim(),
            expiryDate: content.expiryDate === '' ? null : content.expiryDate,
            serialNumbers: null,
          })),
      }));
      return savePackages(consignment.id, input);
    },
    onSuccess: onSaved,
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const update = (index: number, patch: Partial<DraftPackage>): void => {
    setPackages((current) => current.map((pkg, at) => (at === index ? { ...pkg, ...patch } : pkg)));
  };

  return (
    <Modal
      isOpen
      size="lg"
      title={t('sellerDocs.packagesTitle', { reference: consignment.shipmentReference })}
      description={t('sellerDocs.packagesIntro')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('sellerDocs.cancel')}
          </Button>
          <Button
            variant="primary"
            isLoading={save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            {t('sellerDocs.savePackages')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ul className="space-y-1 rounded-md bg-surface-sunken px-3 py-2 text-xs" aria-live="polite">
          {consignment.lines.map((line) => {
            const packedQty = packedBy.get(line.orderItemId) ?? 0;
            return (
              <li
                key={line.orderItemId}
                className={packedQty === line.quantity ? 'text-success' : 'text-warning'}
              >
                {t('sellerDocs.packedOf', {
                  sku: line.sku,
                  packed: packedQty.toLocaleString(),
                  quantity: line.quantity.toLocaleString(),
                })}
              </li>
            );
          })}
        </ul>

        {packages.map((pkg, index) => (
          <fieldset key={index} className="space-y-3 rounded-md border border-border-subtle p-3">
            <legend className="px-1 text-sm font-medium text-ink">
              {t('sellerDocs.packageNumber', { number: index + 1 })}
            </legend>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label={t('sellerDocs.packagingType')}>
                {({ inputId }) => (
                  <Select
                    id={inputId}
                    value={pkg.packagingType}
                    onChange={(event) => {
                      update(index, { packagingType: event.currentTarget.value });
                    }}
                  >
                    {PACKAGING_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(`sellerDocs.type.${type}` as TranslationKey)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {(['lengthMm', 'widthMm', 'heightMm'] as const).map((dimension) => (
                <Field key={dimension} label={t(`sellerDocs.${dimension}` as TranslationKey)}>
                  {({ inputId }) => (
                    <Input
                      id={inputId}
                      inputMode="numeric"
                      value={pkg[dimension]}
                      onChange={(event) => {
                        update(index, { [dimension]: event.currentTarget.value });
                      }}
                    />
                  )}
                </Field>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label={t('sellerDocs.grossWeightKg')} required>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    inputMode="decimal"
                    value={pkg.grossKg}
                    onChange={(event) => {
                      update(index, { grossKg: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
              <Field label={t('sellerDocs.netWeightKg')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    inputMode="decimal"
                    value={pkg.netKg}
                    onChange={(event) => {
                      update(index, { netKg: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
              <Field label={t('sellerDocs.containerNumber')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    value={pkg.containerNumber}
                    onChange={(event) => {
                      update(index, { containerNumber: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
              <Field label={t('sellerDocs.sealNumber')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    value={pkg.sealNumber}
                    onChange={(event) => {
                      update(index, { sealNumber: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                {t('sellerDocs.contents')}
              </p>
              {pkg.contents.map((content, row) => {
                const setContent = (patch: Partial<DraftPackage['contents'][number]>): void => {
                  update(index, {
                    contents: pkg.contents.map((entry, at) =>
                      at === row ? { ...entry, ...patch } : entry,
                    ),
                  });
                };
                return (
                  <div
                    key={row}
                    className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] sm:items-end"
                  >
                    <Field label={t('sellerDocs.item')}>
                      {({ inputId }) => (
                        <Select
                          id={inputId}
                          value={content.orderItemId}
                          onChange={(event) => {
                            setContent({ orderItemId: event.currentTarget.value });
                          }}
                        >
                          {consignment.lines.map((line) => (
                            <option key={line.orderItemId} value={line.orderItemId}>
                              {line.sku} — {line.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label={t('sellerDocs.pieces')}>
                      {({ inputId }) => (
                        <Input
                          id={inputId}
                          inputMode="numeric"
                          value={content.quantity}
                          onChange={(event) => {
                            setContent({ quantity: event.currentTarget.value });
                          }}
                        />
                      )}
                    </Field>
                    <Field label={t('sellerDocs.batch')}>
                      {({ inputId }) => (
                        <Input
                          id={inputId}
                          value={content.batchNumber}
                          onChange={(event) => {
                            setContent({ batchNumber: event.currentTarget.value });
                          }}
                        />
                      )}
                    </Field>
                    <Field label={t('sellerDocs.expiry')}>
                      {({ inputId }) => (
                        <Input
                          id={inputId}
                          type="date"
                          value={content.expiryDate}
                          onChange={(event) => {
                            setContent({ expiryDate: event.currentTarget.value });
                          }}
                        />
                      )}
                    </Field>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('sellerDocs.removeRow')}
                      onClick={() => {
                        update(index, { contents: pkg.contents.filter((_, at) => at !== row) });
                      }}
                    >
                      ×
                    </Button>
                  </div>
                );
              })}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    update(index, {
                      contents: [
                        ...pkg.contents,
                        {
                          orderItemId: consignment.lines[0]?.orderItemId ?? '',
                          quantity: '',
                          batchNumber: '',
                          expiryDate: '',
                        },
                      ],
                    });
                  }}
                >
                  {t('sellerDocs.addRow')}
                </Button>
                {packages.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPackages((current) => current.filter((_, at) => at !== index));
                    }}
                  >
                    {t('sellerDocs.removePackage')}
                  </Button>
                )}
              </div>
            </div>
          </fieldset>
        ))}

        <Button
          size="sm"
          onClick={() => {
            setPackages((current) => [
              ...current,
              {
                packagingType: current.at(-1)?.packagingType ?? 'Carton',
                lengthMm: current.at(-1)?.lengthMm ?? '',
                widthMm: current.at(-1)?.widthMm ?? '',
                heightMm: current.at(-1)?.heightMm ?? '',
                grossKg: '',
                netKg: '',
                containerNumber: '',
                sealNumber: '',
                contents: [],
              },
            ]);
          }}
        >
          {t('sellerDocs.addPackage')}
        </Button>
      </div>
    </Modal>
  );
}

function SplitDialog({
  consignment,
  onClose,
  onSaved,
}: {
  consignment: ConsignmentDocuments;
  onClose: () => void;
  onSaved: (reference: string) => Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [moving, setMoving] = useState<Record<string, string>>({});

  const split = useMutation({
    mutationFn: () =>
      splitConsignment(
        consignment.id,
        consignment.lines
          .map((line) => ({
            orderItemId: line.orderItemId,
            quantity: wholeOrNull(moving[line.orderItemId] ?? '') ?? 0,
          }))
          .filter((line) => line.quantity > 0),
      ),
    onSuccess: (created) => onSaved(created.shipmentReference),
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <Modal
      isOpen
      title={t('sellerDocs.splitTitle', { reference: consignment.shipmentReference })}
      description={t('sellerDocs.splitIntro')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('sellerDocs.cancel')}
          </Button>
          <Button
            variant="primary"
            isLoading={split.isPending}
            onClick={() => {
              split.mutate();
            }}
          >
            {t('sellerDocs.splitConfirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {consignment.lines.map((line) => (
          <Field
            key={line.orderItemId}
            label={`${line.sku} — ${line.name}`}
            hint={t('sellerDocs.splitHint', { quantity: line.quantity.toLocaleString() })}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                inputMode="numeric"
                value={moving[line.orderItemId] ?? ''}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setMoving((current) => ({ ...current, [line.orderItemId]: value }));
                }}
              />
            )}
          </Field>
        ))}
      </div>
    </Modal>
  );
}

function ReasonDialog({
  title,
  description,
  confirm,
  action,
  onClose,
  onDone,
}: {
  title: string;
  description: string;
  confirm: string;
  action: (reason: string) => Promise<unknown>;
  onClose: () => void;
  onDone: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: () => action(reason.trim()),
    onSuccess: onDone,
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <Modal
      isOpen
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('sellerDocs.cancel')}
          </Button>
          <Button
            variant="primary"
            isLoading={mutation.isPending}
            disabled={reason.trim().length < 3}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      <Field label={t('sellerDocs.reason')} required>
        {({ inputId }) => (
          <Textarea
            id={inputId}
            rows={3}
            value={reason}
            onChange={(event) => {
              setReason(event.currentTarget.value);
            }}
          />
        )}
      </Field>
    </Modal>
  );
}
