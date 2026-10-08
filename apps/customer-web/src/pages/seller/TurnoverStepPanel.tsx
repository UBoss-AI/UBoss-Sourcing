/**
 * The turnover eligibility card inside the application, at the top of the
 * Business identity step.
 *
 * For an application that is already under way - including one started before
 * the policy existed - this is where the turnover is declared or corrected,
 * where the supporting evidence goes, and where the seller sees what the
 * marketplace made of it. Three separate facts, shown separately: what they
 * declared, whether it has been verified, and (elsewhere, on the dashboard)
 * whether they are approved.
 *
 * Owners and administrators only: the server refuses everybody else, so the
 * step does not offer it to them.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, LoadingState, type BadgeTone } from '@/components/ui';
import { DocumentIcon, TrashIcon } from '@/components/icons';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import {
  createDocumentLink,
  fetchSellerDocuments,
  uploadSellerDocument,
  withdrawSellerDocument,
} from '@/lib/seller';
import {
  TURNOVER_EVIDENCE_FIELD_KEY,
  fetchSellerTurnover,
  minorToEntry,
  saveSellerTurnover,
  type SellerTurnoverView,
  type TurnoverVerificationState,
} from '@/lib/turnover';
import {
  TurnoverEligibilityCard,
} from './TurnoverEligibilityCard';
import {
  emptyTurnoverDraft,
  turnoverInputFor,
  type TurnoverDraft,
} from './turnover-draft';

const STATE_TONE: Record<TurnoverVerificationState, BadgeTone> = {
  NOT_STARTED: 'neutral',
  AWAITING_INPUT: 'warning',
  IN_PROGRESS: 'brand',
  VERIFIED: 'success',
  FAILED: 'danger',
  PROVIDER_UNCONFIGURED: 'neutral',
  EXPIRED: 'warning',
};

function draftFrom(view: SellerTurnoverView): TurnoverDraft {
  const empty = emptyTurnoverDraft(view.policy);
  const declaration = view.declaration;
  if (declaration === null) return empty;
  return {
    ...empty,
    amountText: minorToEntry(BigInt(declaration.amountMinor), empty.unit, view.policy.currencyExponent),
    // An out-of-date year matches no option, so the select asks again.
    yearKey: `${declaration.financialYearStart}|${declaration.financialYearEnd}`,
    // Ticked again for every change: the declaration covers the figures as they are now.
    declared: false,
    touched: true,
  };
}

export function TurnoverStepPanel({
  isEditable,
  canUpload,
}: {
  isEditable: boolean;
  canUpload: boolean;
}): React.JSX.Element | null {
  const query = useQuery({ queryKey: ['seller', 'turnover'], queryFn: fetchSellerTurnover });

  if (query.isPending) return <LoadingState />;
  // A failed read is not a reason to hide the rest of the step.
  if (query.isError) return null;
  if (!query.data.applies) return null;

  return <Loaded view={query.data} isEditable={isEditable && query.data.isEditable} canUpload={canUpload} />;
}

function Loaded({
  view,
  isEditable,
  canUpload,
}: {
  view: SellerTurnoverView;
  isEditable: boolean;
  canUpload: boolean;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [draft, setDraft] = useState<TurnoverDraft>(() => draftFrom(view));
  const [tried, setTried] = useState(false);

  const input = turnoverInputFor(draft, view.policy);

  const save = useMutation({
    mutationFn: saveSellerTurnover,
    onSuccess: async (next) => {
      client.setQueryData(['seller', 'turnover'], next);
      setDraft((current) => ({ ...current, declared: false }));
      setTried(false);
      await client.invalidateQueries({ queryKey: ['seller', 'onboarding'] });
      toast.success(t('seller.turnover.saved'));
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') setTried(true);
      toast.error(errorMessage(t, error, t('seller.turnover.saveFailed')));
    },
  });

  const declaration = view.declaration;
  const declaredAt =
    declaration === null
      ? null
      : new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium' }).format(new Date(declaration.declaredAt));

  return (
    <TurnoverEligibilityCard
      policy={view.policy}
      draft={draft}
      onChange={setDraft}
      disabled={!isEditable}
      showAllErrors={tried}
    >
      {view.standing === 'OUT_OF_DATE' && (
        <p role="status" className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-ink">
          {t('seller.turnover.outOfDate')}
        </p>
      )}

      {declaration !== null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-surface-sunken px-4 py-3 text-sm">
          <span className="font-medium text-ink">{t('seller.turnover.verification')}</span>
          <Badge tone={STATE_TONE[declaration.verificationState]}>
            {t(`seller.turnover.state.${declaration.verificationState}` as 'seller.turnover.state.VERIFIED')}
          </Badge>
          {declaredAt !== null && (
            <span className="text-xs text-ink-muted">
              {t('seller.turnover.declaredOn', { date: declaredAt, version: declaration.policyVersion })}
            </span>
          )}
          {declaration.decisionReason !== null && (
            <p className="basis-full text-xs leading-relaxed text-ink-muted">
              {t('seller.turnover.reviewerNote', { reason: declaration.decisionReason })}
            </p>
          )}
        </div>
      )}

      {isEditable ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            isLoading={save.isPending}
            onClick={() => {
              setTried(true);
              setDraft((current) => ({ ...current, touched: true }));
              if (input !== null) save.mutate(input);
            }}
          >
            {t('seller.turnover.save')}
          </Button>
          <p className="text-xxs text-ink-subtle">{t('seller.turnover.reviewAgain')}</p>
        </div>
      ) : (
        <p className="text-xs text-ink-muted">{t('seller.turnover.locked')}</p>
      )}

      <EvidencePanel canUpload={canUpload} />
    </TurnoverEligibilityCard>
  );
}

/**
 * Supporting evidence for the turnover, through the same document store as
 * every other piece of evidence: scanned, private, opened only through a
 * short-lived link, and visible only to this seller and the marketplace's
 * reviewers. A new file sends a verified turnover back for review.
 */
function EvidencePanel({ canUpload }: { canUpload: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);

  const documents = useQuery({ queryKey: ['seller', 'documents'], queryFn: fetchSellerDocuments });
  const evidence = (documents.data?.documents ?? []).filter(
    (document) => document.requirementFieldKey === TURNOVER_EVIDENCE_FIELD_KEY,
  );

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['seller', 'documents'] });
    await client.invalidateQueries({ queryKey: ['seller', 'turnover'] });
    await client.invalidateQueries({ queryKey: ['seller', 'onboarding'] });
  };

  const upload = useMutation({
    mutationFn: (chosen: File) =>
      uploadSellerDocument({ file: chosen, kind: 'OTHER', requirementFieldKey: TURNOVER_EVIDENCE_FIELD_KEY }),
    onSuccess: async () => {
      setFile(null);
      if (fileRef.current !== null) fileRef.current.value = '';
      await refresh();
      toast.success(t('seller.turnover.evidence.uploaded'));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.turnover.evidence.uploadFailed')));
    },
  });

  const withdraw = useMutation({
    mutationFn: withdrawSellerDocument,
    onSuccess: refresh,
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.turnover.evidence.removeFailed')));
    },
  });

  const open = useMutation({
    mutationFn: createDocumentLink,
    onSuccess: (link) => {
      window.open(link.url, '_blank', 'noopener,noreferrer');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.turnover.evidence.openFailed')));
    },
  });

  return (
    <div className="space-y-3 border-t border-border pt-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">{t('seller.turnover.evidence.title')}</h3>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">{t('seller.turnover.evidence.hint')}</p>
      </div>

      {evidence.length === 0 ? (
        <p className="text-xs text-ink-subtle">{t('seller.turnover.evidence.none')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {evidence.map((document) => (
            <li key={document.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <DocumentIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-muted" />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{document.originalFileName}</span>
              <Badge tone={document.status === 'APPROVED' ? 'success' : document.status === 'REJECTED' ? 'danger' : 'neutral'}>
                {t(`seller.turnover.evidence.status.${document.status}` as 'seller.turnover.evidence.status.PENDING')}
              </Badge>
              {document.isDownloadable && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    open.mutate(document.id);
                  }}
                >
                  {t('seller.turnover.evidence.open')}
                </Button>
              )}
              {canUpload && document.status !== 'APPROVED' && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('seller.turnover.evidence.remove', { name: document.originalFileName })}
                  isLoading={withdraw.isPending && withdraw.variables === document.id}
                  onClick={() => {
                    withdraw.mutate(document.id);
                  }}
                >
                  <TrashIcon aria-hidden="true" className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canUpload && (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            if (file !== null) upload.mutate(file);
          }}
        >
          <label className="sr-only" htmlFor="turnover-evidence-file">
            {t('seller.turnover.evidence.choose')}
          </label>
          <input
            id="turnover-evidence-file"
            ref={fileRef}
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            onChange={(event) => {
              setFile(event.currentTarget.files?.[0] ?? null);
            }}
            className="block w-full min-w-0 text-sm text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-surface-sunken file:px-3 file:py-2 file:text-sm file:font-medium file:text-ink hover:file:bg-surface-hover sm:flex-1"
          />
          <Button type="submit" size="sm" disabled={file === null} isLoading={upload.isPending}>
            {t('seller.turnover.evidence.upload')}
          </Button>
        </form>
      )}
    </div>
  );
}
