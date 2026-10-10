/**
 * The agreement boxes under the email and password of a sign-in form - one
 * line each, the way most sign-in pages have them:
 *
 *   [ ] I agree to the Terms & Conditions.
 *   [ ] I acknowledge that I have read the Privacy Policy.
 *   ... and on the Company tab, the Seller Hub and - once its documents are
 *   published - the Individual tab, a services agreement.
 *
 * Each box opens its own document in the kit's dialog - the same
 * scroll-to-the-end rule, the same "I agree" / "I acknowledge" - and only that
 * dialog's button ticks it. Opening, Cancel and Escape tick nothing; reading
 * one document unlocks no other; unticking just unticks. A tick counts for the
 * version on screen only: a newer version leaves the box empty.
 *
 * Nothing is recorded here - nobody is signed in yet. The sign-in hands the
 * value to `setPendingSignInAgreements`, and the app's first agreement-status
 * request after sign-in records it.
 */
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n/i18n-context';
import { PolicyDocumentDialog } from './PolicyDocumentDialog';
import { roleTextPrefix } from './role-text';
import { consumerSetComplete, signInBoxesFor, type SignInAgreementValue } from './sign-in-agreements';
import type { AgreementRole, AgreementScope, AgreementsClient, CurrentAgreementDocument } from './types';

type Loaded = Partial<Record<AgreementRole, CurrentAgreementDocument[]>>;

export interface SignInAgreementsProps {
  client: AgreementsClient;
  scope: AgreementScope;
  value: SignInAgreementValue;
  onChange: (next: SignInAgreementValue) => void;
  /** True once every published document has been agreed to. */
  onCompleteChange: (complete: boolean) => void;
}

export function SignInAgreements({ client, scope, value, onChange, onCompleteChange }: SignInAgreementsProps): React.JSX.Element {
  const { t, language } = useI18n();
  // BUYER becomes CONSUMER when every consumer document is published.
  const [resolvedScope, setResolvedScope] = useState<AgreementScope>(scope);
  const boxes = signInBoxesFor(resolvedScope);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [openRole, setOpenRole] = useState<AgreementRole | null>(null);
  // The documents could not be fetched at all. Fails closed: no box can be
  // ticked and the sign-in waits, rather than reading a failure as nothing to agree to.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoaded(null);
    setFailed(false);
    const fetchDocument = async (kind: string): Promise<CurrentAgreementDocument | null> => {
      try {
        return await client.currentDocument(kind, language);
      } catch (error) {
        // Nothing in force for this kind: nothing to agree to, so it
        // does not block - the same rule as the screen after sign-in.
        // Only the server saying so counts; any other failure is a failure.
        if (client.errorCode(error) === 'TERMS_DOCUMENT_UNAVAILABLE') return null;
        throw error;
      }
    };
    const load = async (): Promise<{ target: AgreementScope; entries: Loaded }> => {
      let target = scope;
      if (scope === 'BUYER') {
        const consumer = await Promise.all(signInBoxesFor('CONSUMER').flatMap((box) => box.kinds).map(fetchDocument));
        if (consumerSetComplete(consumer.map((entry) => entry?.document.id ?? null))) target = 'CONSUMER';
      }
      const entries = await Promise.all(
        signInBoxesFor(target).map(async ({ role, kinds }) => {
          const documents = await Promise.all(kinds.map(fetchDocument));
          return [role, documents.filter((entry): entry is CurrentAgreementDocument => entry !== null)] as const;
        }),
      );
      return { target, entries: Object.fromEntries(entries) };
    };
    void load().then(
      ({ target, entries }) => {
        if (!live) return;
        setResolvedScope(target);
        setLoaded(entries);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [client, scope, language, attempt]);

  const documentsOf = (role: AgreementRole): CurrentAgreementDocument[] => loaded?.[role] ?? [];
  const idsOf = (role: AgreementRole): string[] => documentsOf(role).map((entry) => entry.document.id);
  const ticked = (role: AgreementRole): boolean => {
    const ids = idsOf(role);
    const agreed = value[role] ?? [];
    return ids.length > 0 && ids.length === agreed.length && ids.every((id) => agreed.includes(id));
  };
  const complete = loaded !== null && boxes.every(({ role }) => documentsOf(role).length === 0 || ticked(role));

  useEffect(() => {
    onCompleteChange(complete);
  }, [complete, onCompleteChange]);

  const dialogDocuments = openRole === null ? [] : documentsOf(openRole);

  return (
    <fieldset className="space-y-2">
      {/* Named for screen readers; sighted readers have the sentences. */}
      <legend className="sr-only">{t('agreements.login.heading')}</legend>
      {failed && (
        <p role="alert" className="text-[13px] text-ink">
          {t('agreements.dialog.loadFailed')}{' '}
          <button
            type="button"
            className="font-semibold text-brand underline underline-offset-2 hover:no-underline"
            onClick={() => {
              setAttempt((value) => value + 1);
            }}
          >
            {t('agreements.retry')}
          </button>
        </p>
      )}
      {boxes.map(({ role }) => {
        const prefix = roleTextPrefix(resolvedScope, role);
        const checkboxId = `sign-in-agreement-${role.toLowerCase()}`;
        const sentenceId = `${checkboxId}-sentence`;
        const unavailable = loaded !== null && documentsOf(role).length === 0;
        const locked = loaded === null || unavailable;
        const [before = '', after = ''] = t(`${prefix}.label`).split('{{document}}');
        return (
          // One line each on a sign-in-sized form: 13px, and a document name
          // that may wrap inside itself on a narrow phone rather than jumping
          // to a line of its own.
          <div key={role} className="flex items-start gap-2.5 text-[13px] leading-5 text-ink">
            <input
              id={checkboxId}
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-strong text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              checked={ticked(role)}
              disabled={locked}
              aria-labelledby={sentenceId}
              onChange={(event) => {
                if (event.currentTarget.checked) {
                  setOpenRole(role);
                } else {
                  onChange(Object.fromEntries(Object.entries(value).filter(([key]) => key !== role)));
                }
              }}
            />
            <p id={sentenceId}>
              <label htmlFor={checkboxId} className="cursor-pointer">
                {before}
              </label>
              <button
                type="button"
                disabled={locked}
                onClick={() => {
                  setOpenRole(role);
                }}
                className="inline text-left font-semibold text-brand underline underline-offset-2 hover:no-underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:text-ink-muted disabled:no-underline"
              >
                {t(`${prefix}.documentName`)}
              </button>
              <label htmlFor={checkboxId} className="cursor-pointer">
                {after}
              </label>
            </p>
          </div>
        );
      })}

      <PolicyDocumentDialog
        isOpen={openRole !== null}
        role={openRole ?? 'TERMS'}
        documents={dialogDocuments}
        state={dialogDocuments.length === 0 ? 'error' : 'ready'}
        recordedAt={null}
        isSaving={false}
        notice={null}
        onRetry={() => {
          setOpenRole(null);
        }}
        onClose={() => {
          setOpenRole(null);
        }}
        onConfirm={(documentIds) => {
          if (openRole !== null) onChange({ ...value, [openRole]: documentIds });
          setOpenRole(null);
        }}
        pdfUrl={client.pdfUrl}
        pageUrl={client.pageUrl}
        textPrefix={openRole === null ? undefined : roleTextPrefix(resolvedScope, openRole)}
      />
    </fieldset>
  );
}
