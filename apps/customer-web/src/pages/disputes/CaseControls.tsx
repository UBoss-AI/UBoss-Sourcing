/**
 * The case side of a claim (Doc 07): the facts a buyer may add when raising
 * it, the progress the buyer sees afterwards, and the requests the case team
 * addresses to one party with the form that answers them.
 *
 * Shared by the buyer's claim pages and the Seller Hub's dispute page; the
 * `surface` decides which side's requests are read and answered.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { useI18n, type Translate, type TranslationKey } from '@/i18n/i18n-context';
import { newIdempotencyKey } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatMoneyMinor } from '@/lib/format';
import {
  CASE_CATEGORIES,
  answerEvidenceRequest,
  commercialKeys,
  fetchCaseControls,
  type CaseCategory,
  type CaseSurface,
  type CaseDraft,
  type EvidenceRequest,
} from '@/lib/commercial-policy';


/** Optional case facts on the claim form. */
export function ClaimCaseFields({ draft, onChange }: { draft: CaseDraft; onChange: (next: CaseDraft) => void }): React.JSX.Element {
  const { t } = useI18n();
  const set = (patch: Partial<CaseDraft>): void => {
    onChange({ ...draft, ...patch });
  };
  return (
    <fieldset className="space-y-4 rounded-md border border-line px-4 py-4">
      <legend className="px-1 text-sm font-medium text-ink">{t('commercial.claim.legend')}</legend>
      <Field label={t('commercial.claim.categoryLabel')} hint={t('commercial.claim.categoryHint')}>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            value={draft.category}
            onChange={(event) => { set({ category: event.target.value as CaseCategory | '' }); }}
          >
            <option value="">{t('commercial.claim.categoryNone')}</option>
            {CASE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`commercial.category.${category}` as TranslationKey)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {draft.category === 'SAFETY' && (
        <p role="note" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {t('commercial.claim.safetyNote')}
        </p>
      )}
      {draft.category !== '' && (
        <>
          <Field label={t('commercial.claim.urgencyLabel')}>
            {({ inputId }) => (
              <Select id={inputId} value={draft.urgency} onChange={(event) => { set({ urgency: event.target.value as CaseDraft['urgency'] }); }}>
                <option value="NORMAL">{t('commercial.urgency.NORMAL')}</option>
                <option value="URGENT">{t('commercial.urgency.URGENT')}</option>
              </Select>
            )}
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.statutoryBasis}
              onChange={(event) => { set({ statutoryBasis: event.target.checked }); }}
            />
            <span>{t('commercial.claim.statutoryLabel')}</span>
          </label>
          <Field label={t('commercial.claim.lateLabel')}>
            {({ inputId }) => (
              <Textarea id={inputId} rows={2} maxLength={4000} value={draft.lateExplanation} onChange={(event) => { set({ lateExplanation: event.target.value }); }} />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('commercial.claim.quantityLabel')}>
              {({ inputId }) => (
                <Input id={inputId} inputMode="numeric" value={draft.affectedQuantity} onChange={(event) => { set({ affectedQuantity: event.target.value.replace(/\D/g, '') }); }} />
              )}
            </Field>
            <Field label={t('commercial.claim.lotsLabel')} hint={t('commercial.claim.lotsHint')}>
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} value={draft.lotsOrSerials} onChange={(event) => { set({ lotsOrSerials: event.target.value }); }} />
              )}
            </Field>
          </div>
        </>
      )}
    </fieldset>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <p>
      <span className="text-ink-muted">{label}: </span>
      {children}
    </p>
  );
}

const when = (t: Translate, iso: string | null): string => (iso === null ? t('commercial.notYet') : formatDateTime(iso));

/** One request addressed to this party, with the answer form while it is open. */
function RequestItem({ surface, reference, request }: { surface: CaseSurface; reference: string; request: EvidenceRequest }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [key] = useState(newIdempotencyKey);
  const answer = useMutation({
    mutationFn: () => answerEvidenceRequest(surface, reference, request.id, note.trim(), key),
    onSuccess: async () => {
      setNote('');
      toast.success(t('commercial.requests.sent'));
      await queryClient.invalidateQueries({ queryKey: commercialKeys.caseControls(surface, reference) });
    },
    onError: (failure) => { toast.error(errorMessage(t, failure)); },
  });
  const open = request.status === 'OPEN';
  return (
    <li className="space-y-2 rounded-md border border-line px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={open ? 'warning' : 'success'}>{t(open ? 'commercial.requests.open' : 'commercial.requests.answered')}</Badge>
        <span className="text-xs text-ink-muted">{t(`commercial.purpose.${request.purpose}` as TranslationKey, { defaultValue: request.purpose })}</span>
        {request.dueAt !== null && <span className="text-xs text-ink-muted">{t('commercial.requests.due', { when: formatDateTime(request.dueAt) })}</span>}
      </div>
      <p className="whitespace-pre-wrap text-ink">{request.description}</p>
      {open && (
        <div className="space-y-2">
          <Textarea aria-label={t('commercial.requests.answerLabel')} rows={3} maxLength={8000} value={note} onChange={(event) => { setNote(event.target.value); }} />
          <Button variant="primary" size="sm" disabled={note.trim().length < 3 || answer.isPending} isLoading={answer.isPending} onClick={() => { answer.mutate(); }}>
            {t('commercial.requests.answer')}
          </Button>
        </div>
      )}
    </li>
  );
}

export function EvidenceRequestList({ surface, reference, requests }: { surface: CaseSurface; reference: string; requests: EvidenceRequest[] }): React.JSX.Element {
  const { t } = useI18n();
  if (requests.length === 0) return <p className="text-ink-muted">{t('commercial.requests.none')}</p>;
  return (
    <ul className="space-y-3">
      {requests.map((request) => (
        <RequestItem key={request.id} surface={surface} reference={reference} request={request} />
      ))}
    </ul>
  );
}

/** The buyer's view of how the case is being administered. */
export function CaseProgressCard({ reference }: { reference: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({ queryKey: commercialKeys.caseControls('buyer', reference), queryFn: () => fetchCaseControls('buyer', reference) });
  if (query.isPending || query.isError) return null;
  const c = query.data;
  return (
    <Card title={t('commercial.case.title')} className="mt-4" bodyClassName="space-y-3 px-5 py-4 text-sm">
      <div className="grid gap-2 sm:grid-cols-2">
        <Row label={t('commercial.case.category')}>
          {c.category === null ? t('commercial.case.noCategory') : t(`commercial.category.${c.category}` as TranslationKey, { defaultValue: c.category })}
        </Row>
        <Row label={t('commercial.claim.urgencyLabel')}>
          {c.urgency === null ? t('commercial.notYet') : t(`commercial.urgency.${c.urgency}` as TranslationKey, { defaultValue: c.urgency })}
        </Row>
        <Row label={t('commercial.case.acknowledged')}>{when(t, c.acknowledgedAt)}</Row>
        <Row label={t('commercial.case.decisionDue')}>{when(t, c.initialDecisionDueAt)}</Row>
        <Row label={t('commercial.case.appealDue')}>{when(t, c.appealReviewDueAt)}</Row>
      </div>
      {c.lateIntake && <p className="rounded-md bg-surface-muted px-3 py-2 text-ink">{t('commercial.case.lateNote')}</p>}
      {c.reasoning !== null && c.reasoning !== '' && (
        <div>
          <p className="font-medium text-ink">{t('commercial.case.reasoning')}</p>
          <p className="whitespace-pre-wrap">{c.reasoning}</p>
        </div>
      )}
      {c.remedies.length > 0 && (
        <div>
          <p className="font-medium text-ink">{t('commercial.case.remedies')}</p>
          <ul className="mt-1 space-y-2">
            {c.remedies.map((remedy, index) => (
              <li key={`${remedy.kind}-${String(index)}`} className="rounded-md border border-line px-3 py-2">
                <p className="font-medium">
                  {t(`commercial.remedy.${remedy.kind}` as TranslationKey, { defaultValue: remedy.kind })}
                  {remedy.amountMinor !== null && remedy.currency !== null && ` · ${formatMoneyMinor(remedy.amountMinor, remedy.currency)}`}
                </p>
                <p className="text-ink-muted">
                  {t('commercial.case.payer', { party: t(`commercial.party.${remedy.payer}` as TranslationKey, { defaultValue: remedy.payer }) })}
                  {remedy.returnFreightPayer !== null &&
                    ` · ${t('commercial.case.returnFreight', { party: t(`commercial.party.${remedy.returnFreightPayer}` as TranslationKey, { defaultValue: remedy.returnFreightPayer }) })}`}
                  {remedy.expectedCompletionAt !== null && ` · ${t('commercial.case.expected', { when: formatDateTime(remedy.expectedCompletionAt) })}`}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="font-medium text-ink">{t('commercial.requests.title')}</p>
        <EvidenceRequestList surface="buyer" reference={reference} requests={c.requests} />
      </div>
      <p className="border-t border-line pt-3 text-xs text-ink-muted">{t('commercial.case.legalNotice')}</p>
    </Card>
  );
}

/** The Seller Hub's list of requests addressed to the seller. */
export function SellerCaseRequestsCard({ reference }: { reference: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({ queryKey: commercialKeys.caseControls('seller', reference), queryFn: () => fetchCaseControls('seller', reference) });
  if (query.isPending || query.isError) return null;
  return (
    <Card title={t('commercial.requests.sellerTitle')} className="mt-4" bodyClassName="space-y-3 px-5 py-4 text-sm">
      <EvidenceRequestList surface="seller" reference={reference} requests={query.data.requests} />
    </Card>
  );
}
