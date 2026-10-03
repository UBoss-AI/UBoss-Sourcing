/**
 * The shipment documents of one seller order beyond the invoice and packing
 * list (checklist Master row 42): certificate of origin, bill of lading or air
 * waybill, shipping bill, inspection certificates, licences, and whatever a
 * destination or category rule requires.
 *
 * Every save is a NEW version - nothing here edits one - and each version
 * shows who issued it, when it expires and where the marketplace's review of
 * it stands. The commercial invoice and the packing list are issued in the
 * panel above; this one only counts them, so they are not offered twice.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, ErrorState, Field, Input, LoadingState, Select } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate, TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import {
  TRADE_DOCUMENT_KINDS,
  fetchSellerTradeDocuments,
  generateCertificateOfOrigin,
  recordTradeDocumentReference,
  sellerTradeDocumentFileUrl,
  uploadTradeDocument,
  type SellerOrderCompliance,
  type TradeDocument,
  type TradeValidation,
} from '@/lib/shipment-paperwork';

const VALIDATION_TONE: Record<TradeValidation, BadgeTone> = {
  PENDING_REVIEW: 'warning',
  VALID: 'success',
  REJECTED: 'danger',
  EXPIRED: 'danger',
};

function kindLabel(t: Translate, kind: string, title?: string): string {
  if (kind.startsWith('CATEGORY:')) return title ?? kind.slice('CATEGORY:'.length);
  return t(`tradeDocs.kind.${kind}` as TranslationKey);
}

interface FormState {
  kind: string;
  shipmentId: string;
  issuerName: string;
  referenceNumber: string;
  issuedOn: string;
  expiresOn: string;
  title: string;
}

const EMPTY: FormState = {
  kind: 'CERTIFICATE_OF_ORIGIN',
  shipmentId: '',
  issuerName: '',
  referenceNumber: '',
  issuedOn: '',
  expiresOn: '',
  title: '',
};

export function TradeDocumentsPanel({
  sellerOrderId,
  canAct,
}: {
  sellerOrderId: string;
  canAct: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const key = ['seller', 'order', sellerOrderId, 'trade-documents'];
  const [form, setForm] = useState<FormState>(EMPTY);
  const [file, setFile] = useState<File | null>(null);

  const query = useQuery({ queryKey: key, queryFn: () => fetchSellerTradeDocuments(sellerOrderId) });

  const onError = (error: unknown) => {
    toast.error(errorMessage(t, error, t('tradeDocs.saveFailed')));
  };
  const onSaved = async () => {
    await client.invalidateQueries({ queryKey: key });
    setForm(EMPTY);
    setFile(null);
    toast.success(t('tradeDocs.saved'));
  };

  const save = useMutation({
    mutationFn: () => {
      const required = query.data?.required.find((entry) => entry.kind === form.kind);
      const fields = {
        kind: form.kind,
        shipmentId: form.shipmentId === '' ? null : form.shipmentId,
        title: form.title !== '' ? form.title : (required?.name ?? null),
        issuerName: form.issuerName,
        referenceNumber: form.referenceNumber === '' ? null : form.referenceNumber,
        issuedOn: form.issuedOn === '' ? null : form.issuedOn,
        expiresOn: form.expiresOn === '' ? null : form.expiresOn,
      };
      return file === null
        ? recordTradeDocumentReference(sellerOrderId, fields)
        : uploadTradeDocument(sellerOrderId, fields, file);
    },
    onSuccess: onSaved,
    onError,
  });

  const generate = useMutation({
    mutationFn: () => generateCertificateOfOrigin(sellerOrderId, form.shipmentId === '' ? null : form.shipmentId),
    onSuccess: onSaved,
    onError,
  });

  if (query.isLoading) {
    return (
      <Card title={t('tradeDocs.title')}>
        <LoadingState />
      </Card>
    );
  }
  if (query.isError || query.data === undefined) {
    return (
      <Card title={t('tradeDocs.title')}>
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </Card>
    );
  }

  const data = query.data;
  const references = new Map(data.consignments.map((row) => [row.id, row.reference]));
  const categoryKinds = data.required
    .map((entry) => entry.kind)
    .filter((kind) => kind.startsWith('CATEGORY:'));

  const set = (field: keyof FormState) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = event.currentTarget.value;
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <Card title={t('tradeDocs.title')} description={t('tradeDocs.description')} bodyClassName="space-y-5 px-6 py-5">
      <p className="text-sm text-ink-muted" data-testid="trade-docs-issued">
        {t('tradeDocs.issuedSummary', {
          invoices: String(data.issued.commercialInvoices),
          lists: String(data.issued.packingLists),
        })}
      </p>

      {data.required.length > 0 && (
        <section aria-label={t('tradeDocs.requiredHeading')} className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">{t('tradeDocs.requiredHeading')}</h3>
          <ul className="space-y-1">
            {data.required.map((entry) => (
              <li key={`${entry.kind}-${entry.ruleName}`} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink">{entry.name}</span>
                <Badge tone={entry.satisfied ? 'success' : 'danger'}>
                  {entry.satisfied ? t('tradeDocs.requiredMet') : t('tradeDocs.requiredMissing')}
                </Badge>
                {/* Older servers sent no party: read that as the seller's own document. */}
                <Badge tone="neutral">{t(`tradeDocs.party.${entry.responsibleParty ?? 'SELLER'}`)}</Badge>
                {entry.restriction === 'RESTRICTED' && <Badge tone="warning">{t('tradeDocs.restriction.RESTRICTED')}</Badge>}
                {entry.note !== null && <span className="text-xs text-ink-muted">{entry.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <CompliancePanel compliance={data.compliance} />


      {data.documents.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('tradeDocs.empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.documents.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              reference={document.shipmentId === null ? null : (references.get(document.shipmentId) ?? null)}
            />
          ))}
        </ul>
      )}

      {canAct && (
        <form
          className="space-y-3 rounded-lg border border-border p-4"
          aria-label={t('tradeDocs.addHeading')}
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <h3 className="text-sm font-semibold text-ink">{t('tradeDocs.addHeading')}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('tradeDocs.field.kind')}>
              {({ inputId }) => (
                <Select id={inputId} value={form.kind} onChange={set('kind')}>
                  {TRADE_DOCUMENT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`tradeDocs.kind.${kind}`)}
                    </option>
                  ))}
                  {categoryKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {data.required.find((entry) => entry.kind === kind)?.name ?? kind}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('tradeDocs.field.consignment')}>
              {({ inputId }) => (
                <Select id={inputId} value={form.shipmentId} onChange={set('shipmentId')}>
                  <option value="">{t('tradeDocs.wholeOrder')}</option>
                  {data.consignments.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.reference}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('tradeDocs.field.issuer')} hint={t('tradeDocs.field.issuerHint')} required>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={form.issuerName}
                  maxLength={200}
                  required
                  onChange={set('issuerName')}
                />
              )}
            </Field>
            <Field label={t('tradeDocs.field.reference')} hint={t('tradeDocs.field.referenceHint')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={form.referenceNumber}
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={set('referenceNumber')}
                />
              )}
            </Field>
            <Field label={t('tradeDocs.field.issuedOn')}>
              {({ inputId }) => <Input id={inputId} type="date" value={form.issuedOn} onChange={set('issuedOn')} />}
            </Field>
            <Field label={t('tradeDocs.field.expiresOn')}>
              {({ inputId }) => <Input id={inputId} type="date" value={form.expiresOn} onChange={set('expiresOn')} />}
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="relative inline-flex max-w-full min-w-0 cursor-pointer items-center rounded-lg border border-border px-3 py-2 text-sm text-ink hover:bg-surface-sunken">
              <span className="min-w-0 truncate" title={file?.name}>{file === null ? t('tradeDocs.chooseFile') : file.name}</span>
              <input
                type="file"
                accept="application/pdf,image/*"
                className="sr-only"
                data-testid="trade-doc-file"
                onChange={(event) => {
                  setFile(event.currentTarget.files?.[0] ?? null);
                }}
              />
            </label>
            <Button type="submit" variant="primary" isLoading={save.isPending}>
              {t('tradeDocs.save')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              isLoading={generate.isPending}
              onClick={() => {
                generate.mutate();
              }}
            >
              {t('tradeDocs.generateCoo')}
            </Button>
          </div>
          <p className="text-xxs text-ink-muted">{t('tradeDocs.formHint')}</p>
        </form>
      )}
    </Card>
  );
}

/**
 * Destination readiness (JOURNEY-049): what the rules restrict or prohibit,
 * and what holds the goods before dispatch, with who must act. The server
 * refuses "ready for dispatch", a dispatch and a collection while anything
 * here is open; this says why before the seller tries.
 */
function CompliancePanel({ compliance }: { compliance: SellerOrderCompliance }): React.JSX.Element | null {
  const { t } = useI18n();
  const open = compliance.holds.filter((hold) => !hold.covered);
  const destination = compliance.destination === '' ? '—' : compliance.destination;
  if (compliance.restrictions.length === 0 && compliance.holds.length === 0) return null;

  return (
    <section aria-label={t('tradeDocs.hold.title')} className="space-y-2" data-testid="trade-docs-compliance">
      {compliance.restrictions.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-ink">
            {t('tradeDocs.restrictionsHeading', { destination })}
          </h3>
          <ul className="space-y-1">
            {compliance.restrictions.map((entry) => (
              <li key={entry.ruleName} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink">{entry.ruleName}</span>
                {entry.restriction !== 'NONE' && (
                  <Badge tone={entry.restriction === 'PROHIBITED' ? 'danger' : 'warning'}>
                    {t(`tradeDocs.restriction.${entry.restriction}`)}
                  </Badge>
                )}
                {entry.requiresHsVerification && <Badge tone="neutral">{t('tradeDocs.hsVerificationRequired')}</Badge>}
                {entry.note !== null && <span className="text-xs text-ink-muted">{entry.note}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {open.length > 0 ? (
        <div className="space-y-1 rounded-md border border-danger/30 px-3 py-2" role="status">
          <p className="text-sm font-semibold text-danger">{t('tradeDocs.hold.title')}</p>
          <p className="text-xs text-ink-muted">{t('tradeDocs.hold.intro')}</p>
          <ul className="space-y-0.5 text-sm text-ink">
            {open.map((hold) => (
              <li key={hold.key}>
                {t(`tradeDocs.hold.code.${hold.code}`, {
                  rule: hold.ruleName,
                  sku: hold.sku ?? '',
                  destination,
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : compliance.overridden && compliance.override !== null ? (
        <p className="text-xs text-ink-muted" role="status">
          {t('tradeDocs.hold.overridden', { reason: compliance.override.reason })}
        </p>
      ) : compliance.holds.length === 0 ? (
        <p className="text-xs text-ink-muted">{t('tradeDocs.hold.clear')}</p>
      ) : null}
    </section>
  );
}

function DocumentRow({
  document,
  reference,
}: {
  document: TradeDocument;
  reference: string | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const current = document.current;
  const earlier = document.versions.filter((version) => version.superseded);

  return (
    <li className="space-y-1 px-4 py-3 text-sm" data-testid={`trade-doc-${document.kind}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{kindLabel(t, document.kind, document.title)}</span>
        <span className="text-xs text-ink-muted">{reference ?? t('tradeDocs.wholeOrder')}</span>
        {current !== null && (
          <>
            <Badge tone="neutral">{t('tradeDocs.version', { version: String(current.version) })}</Badge>
            <Badge tone={VALIDATION_TONE[current.validation]}>{t(`tradeDocs.validation.${current.validation}`)}</Badge>
          </>
        )}
        <Badge tone={document.buyerVisible ? 'brand' : 'neutral'}>
          {document.buyerVisible ? t('tradeDocs.buyerSees') : t('tradeDocs.buyerHidden')}
        </Badge>
      </div>
      {current !== null && (
        <p className="text-xs text-ink-muted">
          {t('tradeDocs.issuedByLabel')} {current.issuerName}
          {current.referenceNumber !== null && ` · ${t('tradeDocs.numberLabel')} ${current.referenceNumber}`}
          {current.expiresOn !== null && ` · ${t('tradeDocs.expiresLabel')} ${current.expiresOn}`}
          {current.hasFile && (
            <>
              {' · '}
              <a
                className="text-action underline"
                href={sellerTradeDocumentFileUrl(current.id)}
                target="_blank"
                rel="noreferrer"
              >
                {t('tradeDocs.open')}
              </a>
            </>
          )}
        </p>
      )}
      {current?.validationNote != null && (
        <p className="text-xs text-danger">{t('tradeDocs.reviewNote', { note: current.validationNote })}</p>
      )}
      {earlier.length > 0 && (
        <details className="text-xs text-ink-muted">
          <summary className="cursor-pointer">{t('tradeDocs.history', { versions: String(earlier.length) })}</summary>
          <ul className="mt-1 space-y-0.5">
            {earlier.map((version) => (
              <li key={version.id}>
                {t('tradeDocs.version', { version: String(version.version) })} · {version.issuerName} ·{' '}
                {t(`tradeDocs.validation.${version.validation}`)}
                {version.hasFile && (
                  <>
                    {' · '}
                    <a className="underline" href={sellerTradeDocumentFileUrl(version.id)} target="_blank" rel="noreferrer">
                      {t('tradeDocs.open')}
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
