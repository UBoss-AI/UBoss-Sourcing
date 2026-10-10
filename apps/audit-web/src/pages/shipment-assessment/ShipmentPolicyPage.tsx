/**
 * The badge policy for Shipment Assessment: which Audit badge may be offered a
 * waiver, the dispatch-deadline limits and the seller-certificate review
 * period. Every version is kept; a decision records the version it used.
 * Only a supervisor may publish a new version. A seller with no badge always
 * needs assessment - the server refuses a policy that says otherwise.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MutationError, QueryBoundary } from '@/components/console';
import { Button, Callout, Card, DescriptionList, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { assessmentKeys, fetchPolicy, publishPolicy, type Policy, type Requirement } from '@/lib/shipment-assessment';
import { useConsoleMutation } from '@/lib/use-console-mutation';

const RULES: Requirement[] = ['WAIVER_ELIGIBLE', 'WAIVER_ELIGIBLE_WITH_REVIEW', 'ASSESSMENT_REQUIRED'];
const TIERS = ['platinumRule', 'goldRule', 'silverRule', 'bronzeRule'] as const;

export function ShipmentPolicyPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const query = useQuery({ queryKey: assessmentKeys.policy(), queryFn: fetchPolicy });
  return (
    <>
      <PageHeader title={t('shipmentAssessment.policy.title')} description={t('shipmentAssessment.policy.description')} back={{ to: '/shipment-assessment', label: t('shipmentAssessment.title') }} />
      <QueryBoundary query={query}>
        {(data) => (
          <div className="space-y-4">
            {data.current !== null && <PolicyCard policy={data.current} />}
            {can(Permission.SHIPMENT_POLICY) && data.current !== null && <PolicyEditor current={data.current} />}
            {!can(Permission.SHIPMENT_POLICY) && <Callout tone="info">{t('shipmentAssessment.policy.readOnly')}</Callout>}
            <Card title={t('shipmentAssessment.policy.history')} bodyClassName="divide-y divide-border-subtle text-sm">
              {data.history.map((row) => (
                <p key={row.version} className="px-5 py-2">
                  v{String(row.version)} · {formatDateTime(row.createdAt)} · {row.note ?? ''}
                </p>
              ))}
            </Card>
          </div>
        )}
      </QueryBoundary>
    </>
  );
}

function PolicyCard({ policy }: { policy: Policy }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Card title={t('shipmentAssessment.policy.current', { version: String(policy.version) })} bodyClassName="px-5 py-4">
      <DescriptionList
        items={[
          ...TIERS.map((tier) => ({ label: t(`shipmentAssessment.policy.${tier}` as TranslationKey), value: t(`shipmentAssessment.requirement.${policy[tier]}` as TranslationKey) })),
          { label: t('shipmentAssessment.policy.unbadgedRule'), value: t(`shipmentAssessment.requirement.${policy.unbadgedRule}` as TranslationKey) },
          { label: t('shipmentAssessment.policy.defaultDispatchDays'), value: policy.defaultDispatchDays === null ? t('shipmentAssessment.policy.reviewerSets') : String(policy.defaultDispatchDays) },
          { label: t('shipmentAssessment.policy.maxDispatchDays'), value: policy.maxDispatchDays === null ? '—' : String(policy.maxDispatchDays) },
          { label: t('shipmentAssessment.policy.certificateMonths'), value: String(policy.sellerCertificateMonths) },
        ]}
      />
      <p className="mt-3 text-xs text-ink-muted">{t('shipmentAssessment.policy.notLegal')}</p>
    </Card>
  );
}

function PolicyEditor({ current }: { current: Policy }): React.JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState({ ...current, note: '' });
  const publish = useConsoleMutation({
    mutationFn: (_vars, key) =>
      publishPolicy(
        {
          platinumRule: draft.platinumRule,
          goldRule: draft.goldRule,
          silverRule: draft.silverRule,
          bronzeRule: draft.bronzeRule,
          unbadgedRule: 'ASSESSMENT_REQUIRED',
          defaultDispatchDays: draft.defaultDispatchDays,
          maxDispatchDays: draft.maxDispatchDays,
          sellerCertificateMonths: draft.sellerCertificateMonths,
          note: draft.note,
        },
        key,
      ),
    invalidate: [assessmentKeys.policy()],
    successMessage: t('shipmentAssessment.saved'),
  });
  const num = (value: string): number | null => (value.trim() === '' ? null : Number(value));
  return (
    <Card title={t('shipmentAssessment.policy.publish')} bodyClassName="grid gap-3 px-5 py-4 sm:grid-cols-2">
      {TIERS.map((tier) => (
        <Field key={tier} label={t(`shipmentAssessment.policy.${tier}` as TranslationKey)}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={draft[tier]}
              onChange={(event) => {
                setDraft({ ...draft, [tier]: event.target.value as Requirement });
              }}
            >
              {RULES.map((rule) => (
                <option key={rule} value={rule}>
                  {t(`shipmentAssessment.requirement.${rule}` as TranslationKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ))}
      <Field label={t('shipmentAssessment.policy.defaultDispatchDays')} hint={t('shipmentAssessment.policy.defaultHint')}>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            type="number"
            min={1}
            value={draft.defaultDispatchDays === null ? '' : String(draft.defaultDispatchDays)}
            onChange={(event) => {
              setDraft({ ...draft, defaultDispatchDays: num(event.target.value) });
            }}
          />
        )}
      </Field>
      <Field label={t('shipmentAssessment.policy.maxDispatchDays')}>
        {({ inputId }) => (
          <Input
            id={inputId}
            type="number"
            min={1}
            value={draft.maxDispatchDays === null ? '' : String(draft.maxDispatchDays)}
            onChange={(event) => {
              setDraft({ ...draft, maxDispatchDays: num(event.target.value) });
            }}
          />
        )}
      </Field>
      <Field label={t('shipmentAssessment.policy.certificateMonths')}>
        {({ inputId }) => (
          <Input
            id={inputId}
            type="number"
            min={1}
            max={36}
            value={String(draft.sellerCertificateMonths)}
            onChange={(event) => {
              setDraft({ ...draft, sellerCertificateMonths: Number(event.target.value) });
            }}
          />
        )}
      </Field>
      <Field label={t('shipmentAssessment.policy.note')} required>
        {({ inputId }) => (
          <Textarea
            id={inputId}
            value={draft.note}
            onChange={(event) => {
              setDraft({ ...draft, note: event.target.value });
            }}
          />
        )}
      </Field>
      <div className="sm:col-span-2">
        <Button
          variant="primary"
          disabled={publish.isPending || draft.note.trim().length < 10}
          onClick={() => {
            publish.mutate();
          }}
        >
          {t('shipmentAssessment.policy.publish')}
        </Button>
        <MutationError error={publish.error} />
      </div>
    </Card>
  );
}
