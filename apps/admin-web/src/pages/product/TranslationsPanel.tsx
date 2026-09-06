/**
 * Per-language copy for one product or category.
 *
 * A tab per language, with the base text shown beside each field rather than
 * above the form. Somebody writing Greek needs the English in their eye line
 * while they type; making them scroll to check it is how a translation drifts
 * from the thing it is translating.
 *
 * Three decisions worth keeping:
 *
 *   - **Empty means "fall back", not "blank".** Clearing a field deletes the
 *     override and the storefront shows the base text again. There is no way
 *     to publish an empty product name by accident, which a nullable column
 *     and a save button would otherwise allow.
 *   - **"Not checked" is visible on the tab, not buried in the form.** These
 *     rows arrive machine-translated. If the review state is not on the thing
 *     you click, the review does not happen.
 *   - **Saving marks the language reviewed.** A person opened it, read it and
 *     pressed save; that is what reviewed means. The translation script writes
 *     rows with the flag off, so the two never collide.
 *
 * English is absent from the tabs on purpose: it is the base row, edited in
 * the form above this panel. Two places holding the same copy would need a
 * rule for which wins, and there is no good answer.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Button, Card, Input, LoadingState, Textarea } from '@/components/ui';
import { LANGUAGES } from '@/i18n/languages';
import { useI18n } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { cx } from '@/lib/cx';

/** Everything except English, which is the base row. */
const TARGETS = LANGUAGES.filter((entry) => entry.code !== 'en');

interface BaseCopy {
  name: string;
  shortDescription?: string | null;
  description: string | null;
}

interface TranslationRow {
  language: string;
  name: string;
  shortDescription?: string | null;
  description: string | null;
  isReviewed: boolean;
  updatedAt: string;
}

interface TranslationsResponse {
  base: BaseCopy;
  translations: TranslationRow[];
}

interface TranslationsPanelProps {
  /** 'products' or 'categories' - the admin route segment. */
  kind: 'products' | 'categories';
  entityId: string;
  canWrite: boolean;
  /** Categories have no short description. */
  hasShortDescription?: boolean;
}

interface DraftState {
  name: string;
  shortDescription: string;
  description: string;
}

const EMPTY_DRAFT: DraftState = { name: '', shortDescription: '', description: '' };

export function TranslationsPanel({
  kind,
  entityId,
  canWrite,
  hasShortDescription = true,
}: TranslationsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [active, setActive] = useState<string>(TARGETS[0]?.code ?? 'nl');
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);

  const path = `/admin/${kind}/${entityId}/translations`;

  const query = useQuery({
    queryKey: ['translations', kind, entityId],
    queryFn: () => api.get<TranslationsResponse>(path),
    enabled: entityId !== '',
  });

  const current = query.data?.translations.find((row) => row.language === active) ?? null;

  // Reload the form whenever the tab changes or the data arrives. Without
  // this, switching tabs would leave the previous language's text in the
  // boxes and a save would write it to the wrong language.
  useEffect(() => {
    setDraft({
      name: current?.name ?? '',
      shortDescription: current?.shortDescription ?? '',
      description: current?.description ?? '',
    });
  }, [current, active]);

  const save = useMutation({
    mutationFn: () =>
      api.put(`${path}/${active}`, {
        name: draft.name.trim(),
        shortDescription: draft.shortDescription.trim() === '' ? null : draft.shortDescription,
        description: draft.description.trim() === '' ? null : draft.description,
        isReviewed: true,
      }),
    onSuccess: async () => {
      toast.success(t('translations.saved'));
      await queryClient.invalidateQueries({ queryKey: ['translations', kind, entityId] });
    },
    onError: () => {
      toast.error(t('translations.saveFailed'));
    },
  });

  const clear = useMutation({
    mutationFn: () => api.delete(`${path}/${active}`),
    onSuccess: async () => {
      toast.success(t('translations.cleared'));
      await queryClient.invalidateQueries({ queryKey: ['translations', kind, entityId] });
    },
  });

  if (entityId === '') {
    return (
      <Card title={t('translations.heading')}>
        <p className="text-sm text-ink-muted">{t('translations.saveFirst')}</p>
      </Card>
    );
  }

  if (query.isPending) return <LoadingState label={t('translations.loading')} />;

  const base = query.data?.base;
  const done = query.data?.translations.length ?? 0;

  return (
    <Card
      title={t('translations.heading')}
      description={t('translations.coverage', { done, total: TARGETS.length })}
    >
      {/* The tab strip doubles as the coverage report: a language with no row
          reads "not started", one the script wrote reads "not checked". */}
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {TARGETS.map((entry) => {
          const row = query.data?.translations.find((r) => r.language === entry.code);
          const state = row === undefined ? 'missing' : row.isReviewed ? 'reviewed' : 'unchecked';

          return (
            <button
              key={entry.code}
              type="button"
              role="tab"
              aria-selected={active === entry.code}
              onClick={() => {
                setActive(entry.code);
              }}
              className={cx(
                'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                active === entry.code
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border text-ink-muted hover:bg-surface-hover hover:text-ink',
              )}
            >
              {entry.endonym}
              <span
                aria-hidden="true"
                className={cx(
                  'h-1.5 w-1.5 rounded-full',
                  state === 'reviewed' && 'bg-success',
                  state === 'unchecked' && 'bg-warning',
                  state === 'missing' && 'bg-border-strong',
                )}
              />
              <span className="sr-only">{t(`translations.state.${state}`)}</span>
            </button>
          );
        })}
      </div>

      {current !== null && !current.isReviewed && (
        <p className="mt-3 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-ink">
          {t('translations.uncheckedNotice')}
        </p>
      )}

      <div className="mt-4 space-y-4">
        <TranslatedField
          label={t('translations.name')}
          baseText={base?.name ?? ''}
          value={draft.name}
          onChange={(value) => {
            setDraft((d) => ({ ...d, name: value }));
          }}
          disabled={!canWrite}
        />

        {hasShortDescription && (
          <TranslatedField
            label={t('translations.shortDescription')}
            baseText={base?.shortDescription ?? ''}
            value={draft.shortDescription}
            onChange={(value) => {
              setDraft((d) => ({ ...d, shortDescription: value }));
            }}
            disabled={!canWrite}
            multiline
          />
        )}

        <TranslatedField
          label={t('translations.description')}
          baseText={base?.description ?? ''}
          value={draft.description}
          onChange={(value) => {
            setDraft((d) => ({ ...d, description: value }));
          }}
          disabled={!canWrite}
          multiline
        />
      </div>

      {canWrite && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            isLoading={save.isPending}
            disabled={draft.name.trim() === ''}
            onClick={() => {
              save.mutate();
            }}
          >
            {t('translations.save')}
          </Button>

          {current !== null && (
            <Button
              variant="ghost"
              isLoading={clear.isPending}
              onClick={() => {
                clear.mutate();
              }}
            >
              {t('translations.clear')}
            </Button>
          )}

          <p className="text-xs text-ink-subtle">{t('translations.emptyFallsBack')}</p>
        </div>
      )}
    </Card>
  );
}

/**
 * One field, with the source text under it.
 *
 * The base text is `lang="en"` so a screen reader does not read English copy
 * with a Greek voice - the same reason the page sets `<html lang>` at all.
 */
function TranslatedField({
  label,
  baseText,
  value,
  onChange,
  disabled,
  multiline = false,
}: {
  label: string;
  baseText: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  multiline?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-ink">
        {label}
        {multiline ? (
          <Textarea
            className="mt-1.5"
            value={value}
            disabled={disabled}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        ) : (
          <Input
            className="mt-1.5"
            value={value}
            disabled={disabled}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        )}
      </label>

      <p className="mt-1 text-xs text-ink-subtle">
        <span className="font-medium">{t('translations.sourceText')}</span>{' '}
        <span lang="en">{baseText === '' ? t('translations.sourceEmpty') : baseText}</span>
      </p>
    </div>
  );
}
