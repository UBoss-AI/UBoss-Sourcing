/**
 * Marketing choices on the profile page (checklist Master row 11).
 *
 * Three switches - offers by email, offers by text message, and news about
 * new products - all off until the buyer turns one on. Messages about their
 * own orders, payments and account are not marketing and are not affected.
 * The server records every change with its time, so consent can be shown
 * later.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Button } from '@/components/ui';
import { kycApi, kycKeys, type MarketingChoices } from '@/lib/customer-kyc';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { AccountPanel } from './AccountPanel';

type Choice = 'marketingEmailOptIn' | 'marketingSmsOptIn' | 'productNewsOptIn';
const CHOICES: { key: Choice; label: TranslationKey }[] = [
  { key: 'marketingEmailOptIn', label: 'marketing.email' },
  { key: 'marketingSmsOptIn', label: 'marketing.sms' },
  { key: 'productNewsOptIn', label: 'marketing.productNews' },
];

export function MarketingChoicesPanel(): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: kycKeys.marketing, queryFn: kycApi.marketing, retry: false });
  const [draft, setDraft] = useState<Record<Choice, boolean> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (state.data !== undefined) {
      setDraft({
        marketingEmailOptIn: state.data.marketingEmailOptIn,
        marketingSmsOptIn: state.data.marketingSmsOptIn,
        productNewsOptIn: state.data.productNewsOptIn,
      });
    }
  }, [state.data]);

  const save = useMutation({
    mutationFn: kycApi.saveMarketing,
    onSuccess: (next: MarketingChoices) => {
      setProblem(null);
      queryClient.setQueryData(kycKeys.marketing, next);
      toast.success(t('marketing.saved'));
    },
    onError: (error) => {
      setProblem(errorMessage(t, error, t('kyc.failed')));
    },
  });

  if (state.isError) return null;

  const changed =
    draft !== null && state.data !== undefined && CHOICES.some(({ key }) => draft[key] !== state.data[key]);

  return (
    <AccountPanel title={t('marketing.title')} description={t('marketing.description')}>
      {draft === null ? (
        <p className="text-sm text-ink-muted">{t('common.loading')}</p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(draft);
          }}
        >
          <fieldset className="space-y-2">
            <legend className="sr-only">{t('marketing.title')}</legend>
            {CHOICES.map(({ key, label }) => (
              <label key={key} className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-border text-brand"
                  checked={draft[key]}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setDraft((current) => (current === null ? current : { ...current, [key]: checked }));
                  }}
                />
                <span>{t(label)}</span>
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-ink-muted">
            {state.data?.marketingUpdatedAt === null || state.data === undefined
              ? t('marketing.neverChanged')
              : t('marketing.lastChanged', { date: formatDateTime(state.data.marketingUpdatedAt) })}
          </p>
          {problem !== null && (
            <p role="alert" className="text-sm text-danger">
              {problem}
            </p>
          )}
          <Button type="submit" disabled={!changed} isLoading={save.isPending}>
            {t('marketing.save')}
          </Button>
        </form>
      )}
    </AccountPanel>
  );
}
