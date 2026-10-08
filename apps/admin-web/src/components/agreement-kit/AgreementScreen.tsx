/**
 * The agreement screen: shown after signing in, before anything else, while
 * the Terms for this kind of account are not accepted or the Privacy Policy
 * is not acknowledged in a version that still counts.
 *
 * Exactly two controls, and they never move together:
 *
 *   - "I agree to the Terms & Conditions."
 *   - "I acknowledge that I have read the Privacy Policy."
 *
 * A box is ticked only when the SERVER says a record exists - never because
 * somebody clicked it. Clicking an empty box, its sentence or the document's
 * name opens that document; the box is ticked by "I agree" or "I acknowledge"
 * at the end of it, once the record is saved. Clicking a ticked box, before
 * Continue, clears that one record (the server keeps it, marked cleared).
 *
 * Continue is enabled only when both records are saved. Neither box switches
 * on marketing, analytics or any other optional use of data, and the screen
 * says so.
 */
import { useId, useState } from 'react';
import { Button, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { formatAgreementDate } from './format';
import { PolicyDocumentDialog } from './PolicyDocumentDialog';
import type {
  AgreementDocumentStatus,
  AgreementRole,
  AgreementScope,
  AgreementsClient,
  AgreementStatus,
  CurrentAgreementDocument,
} from './types';

export interface AgreementScreenProps {
  client: AgreementsClient;
  scope: AgreementScope;
  status: AgreementStatus;
  onStatus: (status: AgreementStatus) => void;
  /** Ask the server again - after a refused save, or when a version changed. */
  onRefresh: () => Promise<AgreementStatus | null>;
  onContinue: () => void;
  onSignOut: () => void;
  marketplaceName: string;
  supportHref?: string | null;
  privacyRequestsHref?: string | null;
}

function entriesOf(status: AgreementStatus, role: AgreementRole): AgreementDocumentStatus[] {
  return (role === 'TERMS' ? status.terms : [status.privacy]).filter((entry) => !entry.unavailable);
}

function isDone(status: AgreementStatus, role: AgreementRole): boolean {
  return role === 'TERMS' ? status.termsComplete : status.privacyComplete;
}

/** What the dialog shows: what still needs a record, or everything when nothing does. */
function documentsFor(status: AgreementStatus, role: AgreementRole): CurrentAgreementDocument[] {
  const entries = entriesOf(status, role);
  const pending = entries.filter((entry) => entry.record === null);
  return (pending.length > 0 ? pending : entries)
    .map((entry) => entry.current)
    .filter((current): current is CurrentAgreementDocument => current !== null);
}

function latestRecordedAt(status: AgreementStatus, role: AgreementRole): string | null {
  const times = entriesOf(status, role)
    .map((entry) => entry.record?.recordedAt ?? null)
    .filter((value): value is string => value !== null)
    .sort();
  return times.length === 0 ? null : (times[times.length - 1] ?? null);
}

export function AgreementScreen({
  client,
  scope,
  status,
  onStatus,
  onRefresh,
  onContinue,
  onSignOut,
  marketplaceName,
  supportHref = null,
  privacyRequestsHref = null,
}: AgreementScreenProps): React.JSX.Element {
  const { t, language } = useI18n();
  const headingId = useId();
  const [openRole, setOpenRole] = useState<AgreementRole | null>(null);
  const [dialogState, setDialogState] = useState<'loading' | 'ready' | 'error'>('ready');
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState<AgreementRole | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);

  const open = (role: AgreementRole): void => {
    setNotice(null);
    setScreenError(null);
    setDialogState(documentsFor(status, role).length > 0 ? 'ready' : 'error');
    setOpenRole(role);
  };

  const retry = async (): Promise<void> => {
    setDialogState('loading');
    const fresh = await onRefresh();
    setDialogState(fresh !== null && openRole !== null && documentsFor(fresh, openRole).length > 0 ? 'ready' : 'error');
  };

  const confirm = async (role: AgreementRole, documentIds: string[]): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setNotice(null);
    try {
      onStatus(await client.record(scope, role, documentIds, language));
      setOpenRole(null);
    } catch (error) {
      if (client.errorCode(error) === 'TERMS_VERSION_OUTDATED') {
        // Published while the dialog was open. The new text replaces the old
        // in the same dialog, and the end-of-text check starts over.
        setNotice(t('agreements.versionChanged'));
        await onRefresh();
      } else {
        setNotice(t('agreements.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const clear = async (role: AgreementRole): Promise<void> => {
    if (clearing !== null) return;
    setClearing(role);
    setScreenError(null);
    try {
      onStatus(await client.clear(scope, role, language));
    } catch {
      setScreenError(t('agreements.clearFailed'));
      await onRefresh();
    } finally {
      setClearing(null);
    }
  };

  const rows: { role: AgreementRole; sentenceKey: 'agreements.terms.label' | 'agreements.privacy.label'; nameKey: 'agreements.terms.documentName' | 'agreements.privacy.documentName' }[] = [
    { role: 'TERMS', sentenceKey: 'agreements.terms.label', nameKey: 'agreements.terms.documentName' },
    { role: 'PRIVACY', sentenceKey: 'agreements.privacy.label', nameKey: 'agreements.privacy.documentName' },
  ];

  const dialogDocuments = openRole === null ? [] : documentsFor(status, openRole);
  const dialogReadOnly =
    openRole !== null && isDone(status, openRole) && entriesOf(status, openRole).every((entry) => entry.record !== null)
      ? latestRecordedAt(status, openRole)
      : null;

  return (
    <main
      aria-labelledby={headingId}
      className="flex min-h-dvh items-start justify-center px-4 py-10 sm:items-center sm:py-16"
    >
      <div className="w-full max-w-xl motion-safe:animate-fade-in">
        <p className="text-sm font-semibold tracking-tight text-brand">{marketplaceName}</p>
        <h1 id={headingId} className="mt-2 text-title-lg text-ink">
          {t('agreements.screen.title')}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          {t('agreements.screen.intro', { marketplace: marketplaceName })}
        </p>

        <div className="mt-6 space-y-3">
          {rows.map(({ role, sentenceKey, nameKey }) => {
            const entries = role === 'TERMS' ? status.terms : [status.privacy];
            const unavailable = entries.every((entry) => entry.unavailable);
            const done = isDone(status, role) && !unavailable;
            const busy = clearing === role;
            const checkboxId = `agreement-${role.toLowerCase()}`;
            const sentenceId = `${checkboxId}-sentence`;
            const hintId = `${checkboxId}-hint`;
            // Translated whole and split on its own placeholder, so the document's
            // name lands wherever each language puts it.
            const [before = '', after = ''] = t(sentenceKey).split('{{document}}');
            const recordedAt = latestRecordedAt(status, role);
            const version = entriesOf(status, role)
              .map((entry) => entry.record?.version ?? entry.current?.document.version)
              .filter(Boolean)
              .join(', ');

            return (
              <div
                key={role}
                className={cx(
                  'rounded-lg border bg-surface p-4 shadow-sm transition-colors',
                  done ? 'border-success/40' : 'border-border',
                )}
              >
                <div className="flex items-start gap-3 text-sm text-ink">
                  <input
                    id={checkboxId}
                    type="checkbox"
                    className="mt-0.5 h-5 w-5 shrink-0 rounded border-border-strong text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                    checked={done}
                    disabled={unavailable || busy}
                    aria-labelledby={sentenceId}
                    aria-describedby={hintId}
                    onChange={(event) => {
                      if (event.currentTarget.checked) open(role);
                      else void clear(role);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !done && !unavailable) {
                        event.preventDefault();
                        open(role);
                      }
                    }}
                  />
                  <p id={sentenceId} className="leading-snug">
                    <label htmlFor={checkboxId} className="cursor-pointer">
                      {before}
                    </label>
                    <button
                      type="button"
                      disabled={unavailable}
                      onClick={() => {
                        open(role);
                      }}
                      className="font-semibold text-brand underline underline-offset-2 hover:no-underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:text-ink-muted disabled:no-underline"
                    >
                      {t(nameKey)}
                    </button>
                    <label htmlFor={checkboxId} className="cursor-pointer">
                      {after}
                    </label>
                  </p>
                </div>
                <p id={hintId} className="mt-2 flex items-center gap-1.5 pl-8 text-xs text-ink-muted">
                  {busy && <Spinner className="h-3.5 w-3.5" />}
                  {unavailable
                    ? t('agreements.unavailableHint')
                    : done && recordedAt !== null
                      ? t(role === 'TERMS' ? 'agreements.terms.doneHint' : 'agreements.privacy.doneHint', {
                          version,
                          date: formatAgreementDate(recordedAt, language),
                        })
                      : t(role === 'TERMS' ? 'agreements.terms.pendingHint' : 'agreements.privacy.pendingHint')}
                </p>
              </div>
            );
          })}
        </div>

        <p className="mt-4 text-xs leading-relaxed text-ink-muted">{t('agreements.screen.optionalNote')}</p>

        {screenError !== null && (
          <p role="alert" className="mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-ink">
            {screenError}
          </p>
        )}

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Button type="button" variant="ghost" onClick={onSignOut}>
            {t('agreements.signOut')}
          </Button>
          <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
            <Button type="button" variant="primary" disabled={!status.complete} onClick={onContinue} aria-describedby="agreement-continue-hint">
              {t('agreements.continue')}
            </Button>
            <p id="agreement-continue-hint" role="status" className="text-xs text-ink-muted max-sm:text-center">
              {status.complete ? t('agreements.readyToContinue') : t('agreements.continueHint')}
            </p>
          </div>
        </div>

        {(supportHref !== null || privacyRequestsHref !== null) && (
          <p className="mt-8 flex flex-wrap gap-x-4 gap-y-1 border-t border-border-subtle pt-4 text-xs text-ink-muted">
            {supportHref !== null && (
              <a href={supportHref} className="font-medium text-brand hover:underline">
                {t('agreements.help.support')}
              </a>
            )}
            {privacyRequestsHref !== null && (
              <a href={privacyRequestsHref} className="font-medium text-brand hover:underline">
                {t('agreements.help.privacyRequests')}
              </a>
            )}
          </p>
        )}
      </div>

      <PolicyDocumentDialog
        isOpen={openRole !== null}
        role={openRole ?? 'TERMS'}
        documents={dialogDocuments}
        state={dialogDocuments.length === 0 && dialogState === 'ready' ? 'error' : dialogState}
        recordedAt={dialogReadOnly}
        isSaving={saving}
        notice={notice}
        onRetry={() => {
          void retry();
        }}
        onClose={() => {
          setOpenRole(null);
          setNotice(null);
        }}
        onConfirm={(documentIds) => {
          if (openRole !== null) void confirm(openRole, documentIds);
        }}
        pdfUrl={client.pdfUrl}
        pageUrl={client.pageUrl}
      />
    </main>
  );
}

/** A full-page wait or failure, in the screen's own frame. */
export function AgreementScreenFrame({
  marketplaceName,
  children,
}: {
  marketplaceName: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl text-center">
        <p className="text-sm font-semibold tracking-tight text-brand">{marketplaceName}</p>
        <div className="mt-4">{children}</div>
      </div>
    </main>
  );
}
