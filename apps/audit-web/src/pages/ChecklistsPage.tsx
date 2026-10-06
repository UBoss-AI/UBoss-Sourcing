/**
 * Checklists and sampling plans, by category.
 *
 * Each plan version says what an inspector checks for one category and how
 * many units are sampled: an inspection level and an AQL per defect severity,
 * read against MIL-STD-105E / ANSI/ASQ Z1.4 single sampling. A plan is chosen
 * per category; a generic plan is never shown as approved for a category it
 * was not written for.
 *
 *   GET  /audit/checklists
 *   POST /audit/checklists   (a new plan version)
 *   GET  /audit/rules/coverage   (category names, when this person may read rules)
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Callout, Card, PageHeader } from '@/components/ui';
import { CardField, QueryBoundary, ResponsiveTable } from '@/components/console';
import type { Column } from '@/components/DataTable';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, fetchCoverage, fetchPlans } from '@/lib/console-api';
import { CHECKLIST_SECTIONS, type PlanRow } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatDate, formatNumber } from '@/lib/format';
import { PlanForm } from './standards/PlanForm';
import { categoryNames } from './standards/standards-helpers';

export function ChecklistsPage(): React.JSX.Element {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);

  const plans = useQuery({ queryKey: consoleKeys.checklists(), queryFn: fetchPlans });
  const coverage = useQuery({ queryKey: consoleKeys.coverage(), queryFn: fetchCoverage, retry: false });
  const categories = coverage.data?.categories ?? [];
  const names = categoryNames(categories);

  const categoryOf = (plan: PlanRow): React.JSX.Element =>
    plan.categoryId === null ? (
      <Badge tone="warning" dot>
        {t('checklists.noCategory')}
      </Badge>
    ) : (
      <span>{names.get(plan.categoryId) ?? plan.categoryId}</span>
    );

  const aql = (plan: PlanRow): string => `${plan.aqlCritical} / ${plan.aqlMajor} / ${plan.aqlMinor}`;

  const toggleButton = (plan: PlanRow): React.JSX.Element => (
    <Button
      size="sm"
      variant="ghost"
      aria-expanded={openPlanId === plan.id}
      onClick={() => {
        setOpenPlanId((current) => (current === plan.id ? null : plan.id));
      }}
    >
      {openPlanId === plan.id ? t('checklists.hideLines') : t('checklists.showLines', { lines: formatNumber(plan.checklist.length) })}
    </Button>
  );

  const columns: Column<PlanRow>[] = [
    {
      key: 'name',
      header: t('checklists.field.name'),
      render: (plan) => (
        <div>
          <p className="font-medium text-ink">{plan.name}</p>
          <p className="text-xs text-ink-muted">{t('checklists.version', { version: plan.version })}</p>
        </div>
      ),
    },
    { key: 'category', header: t('checklists.field.category'), render: categoryOf },
    {
      key: 'active',
      header: t('common.status'),
      render: (plan) => (
        <Badge tone={plan.isActive ? 'success' : 'neutral'} dot>
          {plan.isActive ? t('checklists.active') : t('checklists.inactive')}
        </Badge>
      ),
      nowrap: true,
    },
    { key: 'level', header: t('checklists.field.level'), render: (plan) => plan.inspectionLevel, align: 'center' },
    { key: 'aql', header: t('checklists.aqlColumn'), render: aql, nowrap: true, secondary: true },
    {
      key: 'dates',
      header: t('checklists.effective'),
      render: (plan) => `${formatDate(plan.effectiveFrom)} – ${plan.effectiveTo === null ? t('checklists.noEnd') : formatDate(plan.effectiveTo)}`,
      secondary: true,
    },
    { key: 'lines', header: t('checklists.lines'), render: toggleButton, align: 'right' },
  ];

  const openPlan = plans.data?.plans.find((plan) => plan.id === openPlanId) ?? null;

  return (
    <>
      <PageHeader
        title={t('screens.checklists.title')}
        description={t('screens.checklists.description')}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('checklists.addPlan')}
          </Button>
        }
      />
      <div className="space-y-6">
        <Callout tone="info" title={t('checklists.samplingTitle')}>
          <p>{t('checklists.samplingExplain')}</p>
          <p className="mt-1">{t('checklists.perCategoryExplain')}</p>
        </Callout>

        <Card title={t('checklists.plansTitle')} description={t('checklists.plansDescription')}>
          <QueryBoundary query={plans}>
            {(data) => (
              <ResponsiveTable
                caption={t('checklists.plansTitle')}
                columns={columns}
                rows={data.plans}
                rowKey={(plan) => plan.id}
                minWidth="52rem"
                emptyTitle={t('checklists.empty')}
                emptyDescription={t('checklists.emptyBody')}
                card={(plan) => (
                  <div className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-ink">{plan.name}</p>
                        <p className="text-xs text-ink-muted">{t('checklists.version', { version: plan.version })}</p>
                      </div>
                      <Badge tone={plan.isActive ? 'success' : 'neutral'} dot>
                        {plan.isActive ? t('checklists.active') : t('checklists.inactive')}
                      </Badge>
                    </div>
                    <CardField label={t('checklists.field.category')}>{categoryOf(plan)}</CardField>
                    <CardField label={t('checklists.field.level')}>{plan.inspectionLevel}</CardField>
                    <CardField label={t('checklists.aqlColumn')}>{aql(plan)}</CardField>
                    <div className="pt-1">{toggleButton(plan)}</div>
                  </div>
                )}
              />
            )}
          </QueryBoundary>
        </Card>

        {openPlan !== null && (
          <Card
            title={t('checklists.linesOf', { name: openPlan.name, version: openPlan.version })}
            bodyClassName="space-y-5 px-5 py-4"
          >
            {CHECKLIST_SECTIONS.map((section) => {
              const items = openPlan.checklist.filter((item) => item.section === section);
              if (items.length === 0) return null;
              return (
                <section key={section}>
                  <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                    {enumLabel(t, 'checklistSection', section)}
                  </h3>
                  <ul className="mt-2 divide-y divide-border-subtle rounded-md border border-border">
                    {items.map((item) => (
                      <li key={item.code} className="px-3 py-2.5 text-sm">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <span className="font-mono text-xs text-ink-muted">{item.code}</span>
                          <span className="text-ink">{item.label}</span>
                        </div>
                        {(item.requirement ?? item.tolerance) != null && (
                          <p className="mt-0.5 text-xs text-ink-muted">
                            {[item.requirement, item.tolerance === null || item.tolerance === undefined ? null : t('checklists.toleranceValue', { tolerance: item.tolerance })]
                              .filter((part): part is string => part !== null && part !== undefined && part !== '')
                              .join(' · ')}
                          </p>
                        )}
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {item.kind !== undefined && <Badge tone="neutral">{enumLabel(t, 'checkKind', item.kind)}</Badge>}
                          {item.mandatory === true && <Badge tone="brand">{t('checklists.field.mandatory')}</Badge>}
                          {item.requiresLabReport === true && <Badge tone="accent">{t('checklists.field.requiresLabReport')}</Badge>}
                          {item.requiresEquipment === true && <Badge tone="accent">{t('checklists.field.requiresEquipment')}</Badge>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </Card>
        )}
      </div>

      {adding && (
        <PlanForm
          isOpen
          categories={categories}
          onClose={() => {
            setAdding(false);
          }}
        />
      )}
    </>
  );
}
