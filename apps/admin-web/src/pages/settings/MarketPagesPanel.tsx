/**
 * Market pages - what the storefront's `/markets/:country` says for each
 * country this business sells to (checklist Master row 8).
 *
 * The storefront always shows the facts it can compute for a market (its
 * currency, what may not be sold there). This panel is for the operator's own
 * words on top: an introduction, duties guidance, delivery and compliance
 * notes, and up to twelve categories to feature. Nothing written here is
 * public until "Publish" is ticked and saved; every save is audited.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Button, Callout, Card, CheckboxField, ErrorState, Field, Input, LoadingState, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

interface MarketRow {
  code: string;
  name: string;
  currencyCode: string;
  profile: {
    headline: string | null;
    intro: string | null;
    dutiesGuidance: string | null;
    deliveryPromise: string | null;
    complianceNotes: string | null;
    featuredCategories: string[];
    isPublished: boolean;
    updatedAt: string;
  } | null;
}

interface Draft {
  headline: string;
  intro: string;
  dutiesGuidance: string;
  deliveryPromise: string;
  complianceNotes: string;
  featured: string;
  isPublished: boolean;
}

function draftFrom(row: MarketRow | undefined): Draft {
  const profile = row?.profile ?? null;
  return {
    headline: profile?.headline ?? '',
    intro: profile?.intro ?? '',
    dutiesGuidance: profile?.dutiesGuidance ?? '',
    deliveryPromise: profile?.deliveryPromise ?? '',
    complianceNotes: profile?.complianceNotes ?? '',
    featured: (profile?.featuredCategories ?? []).join(', '),
    isPublished: profile?.isPublished ?? false,
  };
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

export function MarketPagesPanel(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const canWrite = can(Permission.SETTINGS_WRITE);

  const query = useQuery({
    queryKey: ['market-profiles'],
    queryFn: () => api.get<{ markets: MarketRow[] }>('/admin/settings/market-profiles'),
  });

  const markets = query.data?.markets ?? [];
  const [country, setCountry] = useState('');
  const selected = markets.find((row) => row.code === country) ?? markets[0];
  const [draft, setDraft] = useState<Draft>(draftFrom(undefined));
  const [error, setError] = useState<string | null>(null);

  // A different country, or fresh data after a save, replaces the form.
  useEffect(() => {
    setDraft(draftFrom(selected));
    setError(null);
  }, [selected]);

  const slugs = draft.featured
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const badSlug = slugs.find((slug) => !/^[a-z0-9-]+$/.test(slug));

  const save = useMutation({
    mutationFn: () =>
      api.put(`/admin/settings/market-profiles/${selected?.code ?? ''}`, {
        headline: orNull(draft.headline),
        intro: orNull(draft.intro),
        dutiesGuidance: orNull(draft.dutiesGuidance),
        deliveryPromise: orNull(draft.deliveryPromise),
        complianceNotes: orNull(draft.complianceNotes),
        featuredCategories: slugs,
        isPublished: draft.isPublished,
      }),
    onSuccess: async () => {
      toast.success(t('marketPages.saved'));
      await queryClient.invalidateQueries({ queryKey: ['market-profiles'] });
    },
    onError: (failure) => {
      setError(errorMessage(t, failure, t('marketPages.saveFailed')));
    },
  });

  const set = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  return (
    <Card title={t('marketPages.title')} description={t('marketPages.description')} bodyClassName="space-y-4 px-5 py-4">
      {query.isPending && <LoadingState label={t('marketPages.loading')} />}
      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.isSuccess && selected === undefined && <p className="text-sm text-ink-muted">{t('marketPages.noCountries')}</p>}

      {selected !== undefined && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (badSlug !== undefined) {
              setError(t('marketPages.badSlug', { slug: badSlug }));
              return;
            }
            if (slugs.length > 12) {
              setError(t('marketPages.tooManyCategories'));
              return;
            }
            setError(null);
            save.mutate();
          }}
        >
          {!canWrite && <Callout tone="neutral">{t('settings.youCanReadTheseSettings')}</Callout>}
          {error !== null && (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          )}

          <Field label={t('marketPages.country')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={selected.code}
                onChange={(event) => {
                  setCountry(event.target.value);
                }}
              >
                {markets.map((row) => (
                  <option key={row.code} value={row.code}>
                    {row.name} ({row.currencyCode}){row.profile?.isPublished === true ? ` · ${t('marketPages.published')}` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <p className="text-xs text-ink-muted">
            {t('marketPages.publicAt', { path: `/markets/${selected.code.toLowerCase()}` })}
          </p>

          <Field label={t('marketPages.headline')} hint={t('marketPages.headlineHint')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy} value={draft.headline} maxLength={200} disabled={!canWrite}
                onChange={(event) => { set({ headline: event.target.value }); }} />
            )}
          </Field>

          {(
            [
              ['intro', 'marketPages.intro'],
              ['dutiesGuidance', 'marketPages.duties'],
              ['deliveryPromise', 'marketPages.delivery'],
              ['complianceNotes', 'marketPages.compliance'],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={t(label)}>
              {({ inputId, describedBy }) => (
                <Textarea id={inputId} aria-describedby={describedBy} rows={3} maxLength={4000} value={draft[key]} disabled={!canWrite}
                  onChange={(event) => { set({ [key]: event.target.value }); }} />
              )}
            </Field>
          ))}

          <Field label={t('marketPages.featured')} hint={t('marketPages.featuredHint')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy} value={draft.featured} disabled={!canWrite}
                onChange={(event) => { set({ featured: event.target.value }); }} />
            )}
          </Field>

          <CheckboxField
            label={t('marketPages.publish')}
            description={t('marketPages.publishHint')}
            checked={draft.isPublished}
            disabled={!canWrite}
            onChange={(event) => {
              set({ isPublished: event.target.checked });
            }}
          />

          {canWrite && (
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {t('marketPages.save')}
            </Button>
          )}
        </form>
      )}
    </Card>
  );
}
