/**
 * `/assurance` - how assurance works here (checklist Master row 7).
 *
 * Plain language, and only about what this deployment runs: every number is
 * read from `GET /catalog/assurance`, which reads the operator's own settings.
 * A protection that is not in use is described as not in use, never quietly
 * implied. The last section says what the marketplace does NOT guarantee,
 * because "without overstating assurance" is the requirement and a page that
 * only lists protections overstates by omission.
 *
 * Raising a claim is described as it works today - through support with the
 * order number - until the buyer claim screen exists (Master rows 24 and 30).
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertIcon, CardIcon, ChatBubblesIcon, RepeatIcon, ShieldIcon } from '@/components/icons';
import { ErrorState, LoadingState } from '@/components/ui';
import { useStorefront } from '@/app/storefront-context';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';

interface AssuranceFacts {
  verifiedSuppliers: number;
  inspection: { inUse: boolean; mandatoryRules: number };
  returns: { windowDays: number; replacementEnabled: boolean };
  claims: { claimWindowDays: number; sellerResponseHours: number; decisionHours: number; appealWindowDays: number };
}

function Section({
  id,
  icon,
  title,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-border bg-surface p-5 shadow-card">
      <h2 id={id} className="flex items-center gap-2 text-title-sm text-ink">
        <span className="text-brand">{icon}</span>
        {title}
      </h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-ink">{children}</div>
    </section>
  );
}

export function AssurancePage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  useDocumentMeta({ title: t('assurance.title'), description: t('assurance.intro') }, business.displayName);

  const query = useQuery({
    queryKey: ['assurance'],
    queryFn: () => api.get<AssuranceFacts>('/catalog/assurance'),
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (query.isPending) return <LoadingState label={t('assurance.loading')} />;
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

  const facts = query.data;
  const decisionDays = Math.max(1, Math.round(facts.claims.decisionHours / 24));

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
      <h1 className="text-title-xl text-ink">{t('assurance.title')}</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t('assurance.intro')}</p>

      <div className="mt-6 space-y-4">
        <Section id="assurance-verified" icon={<ShieldIcon className="h-5 w-5" />} title={t('assurance.verifiedTitle')}>
          <p>
            {t('assurance.verifiedBody', {
              count: facts.verifiedSuppliers,
              suppliers: formatNumber(facts.verifiedSuppliers),
            })}
          </p>
          <p className="text-ink-muted">{t('assurance.verifiedLimit')}</p>
        </Section>

        <Section id="assurance-inspection" icon={<ShieldIcon className="h-5 w-5" />} title={t('assurance.inspectionTitle')}>
          {facts.inspection.inUse ? (
            <>
              <p>{t('assurance.inspectionInUse')}</p>
              <p className="text-ink-muted">{t('assurance.inspectionWhere')}</p>
            </>
          ) : (
            <p>{t('assurance.inspectionNotInUse')}</p>
          )}
        </Section>

        <Section id="assurance-payment" icon={<CardIcon className="h-5 w-5" />} title={t('assurance.paymentTitle')}>
          <p>{t('assurance.paymentBody')}</p>
        </Section>

        <Section id="assurance-returns" icon={<RepeatIcon className="h-5 w-5" />} title={t('assurance.returnsTitle')}>
          {facts.returns.windowDays > 0 ? (
            <p>
              {t('assurance.returnsWindow', { count: facts.returns.windowDays, days: formatNumber(facts.returns.windowDays) })}{' '}
              {facts.returns.replacementEnabled ? t('assurance.returnsReplacement') : t('assurance.returnsRefundOnly')}
            </p>
          ) : (
            <p>{t('assurance.returnsNone')}</p>
          )}
        </Section>

        <Section id="assurance-claims" icon={<ChatBubblesIcon className="h-5 w-5" />} title={t('assurance.claimsTitle')}>
          <p>
            {t('assurance.claimsWindow', {
              count: facts.claims.claimWindowDays,
              days: formatNumber(facts.claims.claimWindowDays),
            })}
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              {t('assurance.claimsSeller', {
                count: facts.claims.sellerResponseHours,
                hours: formatNumber(facts.claims.sellerResponseHours),
              })}
            </li>
            <li>{t('assurance.claimsDecision', { count: decisionDays, days: formatNumber(decisionDays) })}</li>
            <li>
              {t('assurance.claimsAppeal', {
                count: facts.claims.appealWindowDays,
                days: formatNumber(facts.claims.appealWindowDays),
              })}
            </li>
          </ol>
          <p>
            {t('assurance.claimsHowToStart')}{' '}
            <Link to="/support" className="font-medium text-brand underline-offset-2 hover:underline">
              {t('assurance.contactSupport')}
            </Link>
          </p>
        </Section>

        <Section id="assurance-limits" icon={<AlertIcon className="h-5 w-5" />} title={t('assurance.limitsTitle')}>
          <ul className="list-disc space-y-1 pl-5">
            <li>{t('assurance.limitStated')}</li>
            <li>{t('assurance.limitDelivery')}</li>
            <li>{t('assurance.limitInspection')}</li>
            <li>{t('assurance.limitNotInsurance')}</li>
          </ul>
        </Section>
      </div>
    </div>
  );
}
