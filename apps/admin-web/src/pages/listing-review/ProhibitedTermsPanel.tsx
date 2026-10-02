/**
 * Prohibited listing terms (JOURNEY-062).
 *
 * Words a listing may not contain. When a seller submits, the listing's text
 * is scanned and every hit appears on it under "Already flagged" for the
 * moderator to judge - it never refuses a listing on its own. Reading the list
 * needs product.read; changing it needs product.publish, the grant that
 * approves listings.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, Input, LoadingState, Select } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { Permission } from '@/lib/permissions';
import { deleteProhibitedTerm, fetchProhibitedTerms, saveProhibitedTerm, type ProhibitedTerm } from '@/lib/sellers';

const KEY = ['admin', 'listing-moderation', 'terms'] as const;

export function ProhibitedTermsPanel(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const client = useQueryClient();
  const mayWrite = can(Permission.PRODUCT_PUBLISH);
  const [term, setTerm] = useState('');
  const [reason, setReason] = useState('');
  const [severity, setSeverity] = useState<ProhibitedTerm['severity']>('WARNING');

  const query = useQuery({ queryKey: KEY, queryFn: fetchProhibitedTerms });

  const add = useMutation({
    mutationFn: () => saveProhibitedTerm(null, { term: term.trim(), reason: reason.trim(), severity, isActive: true }),
    onSuccess: async () => {
      setTerm('');
      setReason('');
      toast.success(t('listingModeration.termSaved'));
      await client.invalidateQueries({ queryKey: KEY });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const toggle = useMutation({
    mutationFn: (row: ProhibitedTerm) =>
      saveProhibitedTerm(row.id, { term: row.term, reason: row.reason, severity: row.severity, isActive: !row.isActive }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: KEY });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteProhibitedTerm(id),
    onSuccess: async () => {
      toast.success(t('listingModeration.termRemoved'));
      await client.invalidateQueries({ queryKey: KEY });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <Card title={t('listingModeration.termsTitle')} description={t('listingModeration.termsDescription')}>
      {mayWrite && (
        <form
          className="grid gap-2 border-b border-border-subtle px-5 py-4 md:grid-cols-[12rem_minmax(0,1fr)_9rem_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <Input
            aria-label={t('listingModeration.term')}
            placeholder={t('listingModeration.term')}
            maxLength={120}
            value={term}
            onChange={(event) => {
              setTerm(event.currentTarget.value);
            }}
          />
          <Input
            aria-label={t('listingModeration.termReason')}
            placeholder={t('listingModeration.termReason')}
            maxLength={512}
            value={reason}
            onChange={(event) => {
              setReason(event.currentTarget.value);
            }}
          />
          <Select
            aria-label={t('listingModeration.termSeverity')}
            value={severity}
            onChange={(event) => {
              setSeverity(event.currentTarget.value as ProhibitedTerm['severity']);
            }}
          >
            {(['BLOCKER', 'WARNING', 'ADVISORY'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`listingModeration.severity.${value}` as TranslationKey)}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="primary" disabled={term.trim().length < 2 || reason.trim().length < 3} isLoading={add.isPending}>
            {t('listingModeration.addTerm')}
          </Button>
        </form>
      )}
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : query.data.terms.length === 0 ? (
        <EmptyState title={t('listingModeration.noTerms')} />
      ) : (
        <ul className="divide-y divide-border-subtle">
          {query.data.terms.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <div className="min-w-0">
                <span className="font-mono font-medium text-ink">{row.term}</span>{' '}
                <Badge tone={row.severity === 'BLOCKER' ? 'danger' : 'warning'}>
                  {t(`listingModeration.severity.${row.severity}` as TranslationKey)}
                </Badge>{' '}
                {!row.isActive && <Badge>{t('listingModeration.off')}</Badge>}
                <p className="text-xxs text-ink-muted">{row.reason}</p>
              </div>
              {mayWrite && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      toggle.mutate(row);
                    }}
                  >
                    {row.isActive ? t('listingModeration.switchOff') : t('listingModeration.switchOn')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      remove.mutate(row.id);
                    }}
                  >
                    {t('listingModeration.remove')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
