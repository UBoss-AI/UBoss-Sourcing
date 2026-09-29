/**
 * Fee rules - finance only (checklist SCREEN-068).
 *
 * Value bands, volume tiers, seller tiers and promotions that sit on top of a
 * platform-fee policy. The screen is the editor for them: draft one, submit it,
 * and a SECOND member of finance staff approves it. That is the whole point of
 * the maker-checker: whoever created, edited or submitted a rule is never the
 * one who publishes it, and the Approve button says so instead of failing.
 *
 * A published rule is never edited. **Replace** drafts a new rule of the same
 * kind and scope that supersedes it; approving the new one retires the old one
 * in the same step. A rule applies only to orders confirmed while it is live,
 * and a settlement already calculated is never recalculated.
 *
 * Reading needs `finance.policy.read`; every change needs
 * `finance.policy.write`. The server checks both again.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import {
  FEE_RULE_KINDS,
  FEE_RULE_SCOPES,
  FEE_RULE_STATUSES,
  approveFeeRule,
  createFeeRule,
  fetchFeeRuleOrders,
  fetchFeeRules,
  isIndependentOf,
  rejectFeeRule,
  retireFeeRule,
  submitFeeRule,
  updateFeeRule,
  type FeeRuleInput,
  type FeeRuleKind,
  type FeeRuleScope,
  type FeeRuleStatus,
  type FeeRuleView,
} from '@/lib/fee-rules';
import { currencyExponent, formatDate, formatMoney, majorToMinor } from '@/lib/format';
import { Permission } from '@/lib/permissions';

const KEY = ['admin', 'platform-fee-rules'] as const;

const STATUS_TONE: Record<FeeRuleStatus, BadgeTone> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  PUBLISHED: 'success',
  RETIRED: 'neutral',
};

/** A whole number of minor units, back to the text a person types. */
function minorToMajor(minor: string | undefined, exponent: number): string {
  if (minor === undefined) return '';
  if (exponent === 0) return minor;
  const padded = minor.padStart(exponent + 1, '0');
  return `${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

function key(prefix: string, value: string): TranslationKey {
  return `${prefix}.${value}` as TranslationKey;
}

export function FeeRulesPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { can, user } = useSession();
  const mayWrite = can(Permission.FINANCE_POLICY_WRITE);
  const [status, setStatus] = useState<FeeRuleStatus | ''>('');
  const query = useQuery({
    queryKey: [...KEY, status],
    queryFn: () => fetchFeeRules(status === '' ? undefined : status),
  });
  const [editing, setEditing] = useState<{ rule: FeeRuleView | null; replaces: FeeRuleView | null } | null>(null);
  const [approving, setApproving] = useState<FeeRuleView | null>(null);
  const [sendingBack, setSendingBack] = useState<FeeRuleView | null>(null);
  const [retiring, setRetiring] = useState<FeeRuleView | null>(null);
  const [showingOrders, setShowingOrders] = useState<FeeRuleView | null>(null);

  function refresh(): void {
    void client.invalidateQueries({ queryKey: KEY });
  }
  const fail = (error: unknown): void => {
    toast.error(errorMessage(t, error));
  };

  const submit = useMutation({
    mutationFn: (id: string) => submitFeeRule(id),
    onSuccess: () => {
      toast.success(t('feeRules.submitted'));
      refresh();
    },
    onError: fail,
  });
  const approve = useMutation({
    mutationFn: (id: string) => approveFeeRule(id),
    onSuccess: () => {
      setApproving(null);
      toast.success(t('feeRules.approved'));
      refresh();
    },
    onError: (error: unknown) => {
      setApproving(null);
      fail(error);
      refresh();
    },
  });
  const retire = useMutation({
    mutationFn: (id: string) => retireFeeRule(id),
    onSuccess: () => {
      setRetiring(null);
      toast.success(t('feeRules.retired'));
      refresh();
    },
    onError: fail,
  });

  function terms(rule: FeeRuleView): string {
    const rate = rule.percentRate ?? '';
    switch (rule.kind) {
      case 'VALUE_BAND':
        return t('feeRules.terms.VALUE_BAND', {
          from: formatMoney(rule.minValue),
          to: rule.maxValue === null ? t('feeRules.noUpperLimit') : formatMoney(rule.maxValue),
          rate,
        });
      case 'VOLUME_TIER':
        return t('feeRules.terms.VOLUME_TIER', {
          threshold: formatMoney(rule.volumeThreshold),
          days: String(rule.volumeWindowDays ?? ''),
          rate,
        });
      case 'SELLER_TIER':
        return t('feeRules.terms.SELLER_TIER', { tier: rule.sellerTier ?? '', rate });
      case 'PROMOTION':
        return t('feeRules.terms.PROMOTION', { discount: rule.discountPercent ?? '' });
    }
  }

  const columns: Column<FeeRuleView>[] = [
    {
      key: 'name',
      header: t('feeRules.column.rule'),
      render: (row) => (
        <div>
          <p className="font-medium text-ink">{row.name}</p>
          <p className="text-xxs text-ink-subtle">
            {t(key('feeRules.kind', row.kind))} · {t(key('feeRules.scope', row.scope))}
            {row.scope !== 'GLOBAL' && ` (${row.scopeKey})`}
          </p>
        </div>
      ),
    },
    {
      key: 'terms',
      header: t('feeRules.column.terms'),
      render: (row) => <span className="text-sm text-ink">{terms(row)}</span>,
    },
    {
      key: 'effective',
      header: t('feeRules.column.effective'),
      secondary: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">
          {formatDate(row.effectiveFrom)}
          {row.effectiveTo !== null && ` → ${formatDate(row.effectiveTo)}`}
        </span>
      ),
    },
    {
      key: 'status',
      header: t('feeRules.column.status'),
      render: (row) => (
        <div className="space-y-1">
          <Badge tone={STATUS_TONE[row.status]}>{t(key('feeRules.status', row.status))}</Badge>
          {row.status === 'DRAFT' && row.rejectionReason !== null && (
            <p className="max-w-xs text-xxs text-danger">
              {t('feeRules.sentBack', { reason: row.rejectionReason })}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (row) => {
        const independent = isIndependentOf(row, user?.id);
        return (
          <div className="flex flex-wrap justify-end gap-1.5">
            {mayWrite && row.status === 'DRAFT' && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setEditing({ rule: row, replaces: null });
                  }}
                >
                  {t('feeRules.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  isLoading={submit.isPending && submit.variables === row.id}
                  onClick={() => {
                    submit.mutate(row.id);
                  }}
                >
                  {t('feeRules.submit')}
                </Button>
              </>
            )}
            {mayWrite && row.status === 'PENDING_APPROVAL' && (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!independent}
                  title={independent ? undefined : t('feeRules.approveNotYou')}
                  onClick={() => {
                    setApproving(row);
                  }}
                >
                  {t('feeRules.approve')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSendingBack(row);
                  }}
                >
                  {t('feeRules.sendBack')}
                </Button>
                {!independent && (
                  <p className="w-full text-right text-xxs text-ink-muted">{t('feeRules.approveNotYou')}</p>
                )}
              </>
            )}
            {mayWrite && row.status === 'PUBLISHED' && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setEditing({ rule: null, replaces: row });
                  }}
                >
                  {t('feeRules.replace')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRetiring(row);
                  }}
                >
                  {t('feeRules.retire')}
                </Button>
              </>
            )}
            {(row.status === 'PUBLISHED' || row.status === 'RETIRED') && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowingOrders(row);
                }}
              >
                {t('feeRules.orders', { orders: String(row.settlementCount) })}
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('feeRules.heading')}
        description={t('feeRules.intro')}
        actions={
          mayWrite ? (
            <Button
              variant="primary"
              onClick={() => {
                setEditing({ rule: null, replaces: null });
              }}
            >
              {t('feeRules.new')}
            </Button>
          ) : undefined
        }
      />

      <Callout tone="info">{t('feeRules.makerChecker')}</Callout>

      <div className="max-w-xs">
        <Field label={t('feeRules.filter.status')}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={status}
              onChange={(event) => {
                setStatus(event.currentTarget.value as FeeRuleStatus | '');
              }}
            >
              <option value="">{t('feeRules.filter.all')}</option>
              {FEE_RULE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(key('feeRules.status', value))}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Card>
        <DataTable
          caption={t('feeRules.heading')}
          columns={columns}
          rows={query.data?.rules ?? []}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
          minWidth="64rem"
          emptyTitle={t('feeRules.emptyTitle')}
          emptyDescription={t('feeRules.emptyBody')}
        />
      </Card>

      {editing !== null && (
        <RuleDialog
          rule={editing.rule}
          replaces={editing.replaces}
          onClose={() => {
            setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}

      <ConfirmDialog
        isOpen={approving !== null}
        onClose={() => {
          setApproving(null);
        }}
        onConfirm={() => {
          if (approving !== null) approve.mutate(approving.id);
        }}
        title={t('feeRules.approveTitle')}
        body={t(approving?.supersedesRuleId != null ? 'feeRules.approveBodyReplaces' : 'feeRules.approveBody')}
        confirmLabel={t('feeRules.approve')}
        isWorking={approve.isPending}
      />

      <ConfirmDialog
        isOpen={retiring !== null}
        onClose={() => {
          setRetiring(null);
        }}
        onConfirm={() => {
          if (retiring !== null) retire.mutate(retiring.id);
        }}
        title={t('feeRules.retireTitle')}
        body={t('feeRules.retireBody')}
        confirmLabel={t('feeRules.retire')}
        isDangerous
        isWorking={retire.isPending}
      />

      {sendingBack !== null && (
        <SendBackDialog
          rule={sendingBack}
          onClose={() => {
            setSendingBack(null);
          }}
          onDone={() => {
            setSendingBack(null);
            refresh();
          }}
        />
      )}

      {showingOrders !== null && (
        <OrdersDialog
          rule={showingOrders}
          onClose={() => {
            setShowingOrders(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

interface FormState {
  kind: FeeRuleKind;
  scope: FeeRuleScope;
  subject: string;
  name: string;
  currency: string;
  minValue: string;
  maxValue: string;
  volumeThreshold: string;
  volumeWindowDays: string;
  sellerTier: string;
  percentRate: string;
  discountPercent: string;
  effectiveFrom: string;
  effectiveTo: string;
  notes: string;
}

function initialForm(rule: FeeRuleView | null, replaces: FeeRuleView | null): FormState {
  const source = rule ?? replaces;
  const currency = source?.currency ?? 'INR';
  const exponent = currencyExponent(currency);
  return {
    kind: source?.kind ?? 'VALUE_BAND',
    scope: source?.scope ?? 'GLOBAL',
    subject: source?.sellerAccountId ?? source?.categoryId ?? source?.marketCountry ?? '',
    name: source?.name ?? '',
    currency,
    minValue: minorToMajor(source?.minValue?.minor, exponent),
    maxValue: minorToMajor(source?.maxValue?.minor, exponent),
    volumeThreshold: minorToMajor(source?.volumeThreshold?.minor, exponent),
    volumeWindowDays: source?.volumeWindowDays === null || source?.volumeWindowDays === undefined ? '' : String(source.volumeWindowDays),
    sellerTier: source?.sellerTier ?? '',
    percentRate: source?.percentRate ?? '',
    discountPercent: source?.discountPercent ?? '',
    // A replacement starts from today, not from the old rule's start date.
    effectiveFrom: rule === null ? '' : rule.effectiveFrom.slice(0, 10),
    effectiveTo: source?.effectiveTo?.slice(0, 10) ?? '',
    notes: source?.notes ?? '',
  };
}

function RuleDialog({
  rule,
  replaces,
  onClose,
  onSaved,
}: {
  rule: FeeRuleView | null;
  replaces: FeeRuleView | null;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => initialForm(rule, replaces));
  const [problem, setProblem] = useState<string | null>(null);
  const [badFields, setBadFields] = useState<string[]>([]);
  const locked = rule !== null || replaces !== null;

  function set<K extends keyof FormState>(field: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function body(): FeeRuleInput | null {
    const exponent = currencyExponent(form.currency);
    const money = (text: string): string | null | undefined => {
      if (text.trim() === '') return null;
      return majorToMinor(text, exponent) ?? undefined;
    };
    const minValueMinor = form.kind === 'VALUE_BAND' ? money(form.minValue) : null;
    const maxValueMinor = form.kind === 'VALUE_BAND' ? money(form.maxValue) : null;
    const volumeThresholdMinor = form.kind === 'VOLUME_TIER' ? money(form.volumeThreshold) : null;
    // `undefined` means the text was not a valid amount for the currency.
    if (minValueMinor === undefined || maxValueMinor === undefined || volumeThresholdMinor === undefined) {
      setBadFields(
        [
          minValueMinor === undefined ? 'minValueMinor' : '',
          maxValueMinor === undefined ? 'maxValueMinor' : '',
          volumeThresholdMinor === undefined ? 'volumeThresholdMinor' : '',
        ].filter((field) => field !== ''),
      );
      setProblem(t('feeRules.amountInvalid'));
      return null;
    }
    const day = (text: string): string | null => (text === '' ? null : new Date(`${text}T00:00:00.000Z`).toISOString());
    return {
      kind: form.kind,
      scope: form.scope,
      ...(form.scope === 'SELLER' ? { sellerAccountId: form.subject.trim() } : {}),
      ...(form.scope === 'CATEGORY' ? { categoryId: form.subject.trim() } : {}),
      ...(form.scope === 'MARKET' ? { marketCountry: form.subject.trim().toUpperCase() } : {}),
      name: form.name.trim(),
      currency: form.kind === 'VALUE_BAND' || form.kind === 'VOLUME_TIER' ? form.currency.trim().toUpperCase() : null,
      minValueMinor,
      maxValueMinor,
      volumeThresholdMinor,
      volumeWindowDays:
        form.kind === 'VOLUME_TIER' && form.volumeWindowDays.trim() !== '' ? Number(form.volumeWindowDays) : null,
      sellerTier: form.kind === 'SELLER_TIER' ? form.sellerTier.trim() : null,
      percentRate: form.kind === 'PROMOTION' ? null : form.percentRate.trim(),
      discountPercent: form.kind === 'PROMOTION' ? form.discountPercent.trim() : null,
      effectiveFrom: day(form.effectiveFrom),
      effectiveTo: day(form.effectiveTo),
      notes: form.notes.trim() === '' ? null : form.notes.trim(),
      ...(replaces !== null ? { supersedesRuleId: replaces.id } : {}),
    };
  }

  const save = useMutation({
    mutationFn: (input: FeeRuleInput) => (rule === null ? createFeeRule(input) : updateFeeRule(rule.id, input)),
    onSuccess: () => {
      toast.success(t('feeRules.draftSaved'));
      onSaved();
    },
    onError: (error: unknown) => {
      setBadFields(error instanceof ApiError ? error.details.flatMap((detail) => (detail.field === undefined ? [] : [detail.field])) : []);
      setProblem(errorMessage(t, error));
    },
  });

  const has = (field: string): boolean => badFields.includes(field);
  const errorFor = (field: string): string | undefined => (has(field) ? t('feeRules.fieldInvalid') : undefined);

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={rule !== null ? t('feeRules.editTitle') : replaces !== null ? t('feeRules.replaceTitle') : t('feeRules.new')}
      description={replaces !== null ? t('feeRules.replaceBody', { name: replaces.name }) : t('feeRules.newBody')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            isLoading={save.isPending}
            disabled={form.name.trim().length < 2}
            onClick={() => {
              setProblem(null);
              setBadFields([]);
              const input = body();
              if (input !== null) save.mutate(input);
            }}
          >
            {t('feeRules.saveDraft')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {problem !== null && <Callout tone="danger">{problem}</Callout>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('feeRules.field.name')} error={errorFor('name')}>
            {({ inputId }) => (
              <Input
                id={inputId}
                value={form.name}
                maxLength={160}
                onChange={(event) => {
                  set('name', event.currentTarget.value);
                }}
              />
            )}
          </Field>
          <Field label={t('feeRules.field.kind')} hint={locked ? t('feeRules.kindLocked') : undefined}>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={form.kind}
                disabled={locked}
                onChange={(event) => {
                  set('kind', event.currentTarget.value as FeeRuleKind);
                }}
              >
                {FEE_RULE_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {t(key('feeRules.kind', value))}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('feeRules.field.scope')}>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={form.scope}
                disabled={locked}
                onChange={(event) => {
                  set('scope', event.currentTarget.value as FeeRuleScope);
                }}
              >
                {FEE_RULE_SCOPES.map((value) => (
                  <option key={value} value={value}>
                    {t(key('feeRules.scope', value))}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {form.scope !== 'GLOBAL' && (
            <Field label={t(key('feeRules.subject', form.scope))} error={errorFor('scope')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  value={form.subject}
                  disabled={locked}
                  onChange={(event) => {
                    set('subject', event.currentTarget.value);
                  }}
                />
              )}
            </Field>
          )}

          {(form.kind === 'VALUE_BAND' || form.kind === 'VOLUME_TIER') && (
            <Field label={t('feeRules.field.currency')} error={errorFor('currency')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  value={form.currency}
                  maxLength={3}
                  onChange={(event) => {
                    set('currency', event.currentTarget.value.toUpperCase());
                  }}
                />
              )}
            </Field>
          )}
          {form.kind === 'VALUE_BAND' && (
            <>
              <Field label={t('feeRules.field.minValue')} error={errorFor('minValueMinor')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    inputMode="decimal"
                    value={form.minValue}
                    onChange={(event) => {
                      set('minValue', event.currentTarget.value);
                    }}
                  />
                )}
              </Field>
              <Field label={t('feeRules.field.maxValue')} hint={t('feeRules.field.maxValueHint')} error={errorFor('maxValueMinor')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    inputMode="decimal"
                    value={form.maxValue}
                    onChange={(event) => {
                      set('maxValue', event.currentTarget.value);
                    }}
                  />
                )}
              </Field>
            </>
          )}
          {form.kind === 'VOLUME_TIER' && (
            <>
              <Field label={t('feeRules.field.volumeThreshold')} error={errorFor('volumeThresholdMinor')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    inputMode="decimal"
                    value={form.volumeThreshold}
                    onChange={(event) => {
                      set('volumeThreshold', event.currentTarget.value);
                    }}
                  />
                )}
              </Field>
              <Field label={t('feeRules.field.volumeWindowDays')} error={errorFor('volumeWindowDays')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    inputMode="numeric"
                    value={form.volumeWindowDays}
                    onChange={(event) => {
                      set('volumeWindowDays', event.currentTarget.value);
                    }}
                  />
                )}
              </Field>
            </>
          )}
          {form.kind === 'SELLER_TIER' && (
            <Field label={t('feeRules.field.sellerTier')} error={errorFor('sellerTier')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  value={form.sellerTier}
                  maxLength={32}
                  onChange={(event) => {
                    set('sellerTier', event.currentTarget.value);
                  }}
                />
              )}
            </Field>
          )}
          {form.kind !== 'PROMOTION' ? (
            <Field label={t('feeRules.field.percentRate')} error={errorFor('percentRate')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  inputMode="decimal"
                  value={form.percentRate}
                  onChange={(event) => {
                    set('percentRate', event.currentTarget.value);
                  }}
                />
              )}
            </Field>
          ) : (
            <Field label={t('feeRules.field.discountPercent')} hint={t('feeRules.field.discountHint')} error={errorFor('discountPercent')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="decimal"
                  value={form.discountPercent}
                  onChange={(event) => {
                    set('discountPercent', event.currentTarget.value);
                  }}
                />
              )}
            </Field>
          )}
          <Field label={t('feeRules.field.effectiveFrom')} hint={t('feeRules.field.effectiveFromHint')} error={errorFor('effectiveFrom')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                type="date"
                value={form.effectiveFrom}
                onChange={(event) => {
                  set('effectiveFrom', event.currentTarget.value);
                }}
              />
            )}
          </Field>
          <Field
            label={t('feeRules.field.effectiveTo')}
            hint={form.kind === 'PROMOTION' ? t('feeRules.field.effectiveToRequired') : t('feeRules.field.effectiveToHint')}
            error={errorFor('effectiveTo')}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                type="date"
                value={form.effectiveTo}
                onChange={(event) => {
                  set('effectiveTo', event.currentTarget.value);
                }}
              />
            )}
          </Field>
        </div>
        <Field label={t('feeRules.field.notes')}>
          {({ inputId }) => (
            <Textarea
              id={inputId}
              rows={2}
              maxLength={1024}
              value={form.notes}
              onChange={(event) => {
                set('notes', event.currentTarget.value);
              }}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sending back, and the orders a rule touched
// ---------------------------------------------------------------------------

function SendBackDialog({ rule, onClose, onDone }: { rule: FeeRuleView; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const send = useMutation({
    mutationFn: () => rejectFeeRule(rule.id, reason.trim()),
    onSuccess: () => {
      toast.success(t('feeRules.sentBackToast'));
      onDone();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('feeRules.sendBackTitle', { name: rule.name })}
      description={t('feeRules.sendBackBody')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={reason.trim().length < 10}
            isLoading={send.isPending}
            onClick={() => {
              send.mutate();
            }}
          >
            {t('feeRules.sendBack')}
          </Button>
        </div>
      }
    >
      <Field label={t('feeRules.field.reason')} hint={t('feeRules.field.reasonHint')}>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={(event) => {
              setReason(event.currentTarget.value);
            }}
          />
        )}
      </Field>
    </Modal>
  );
}

function OrdersDialog({ rule, onClose }: { rule: FeeRuleView; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: [...KEY, rule.id, 'orders'], queryFn: () => fetchFeeRuleOrders(rule.id) });

  return (
    <Modal isOpen onClose={onClose} title={t('feeRules.ordersTitle', { name: rule.name })}>
      {query.isPending ? (
        <p className="text-sm text-ink-muted">{t('feeRules.loading')}</p>
      ) : (query.data?.orders.length ?? 0) === 0 ? (
        <p className="text-sm text-ink-muted">{t('feeRules.noOrders')}</p>
      ) : (
        <ul className="divide-y divide-border-subtle text-sm">
          {query.data?.orders.map((order) => (
            <li key={order.sellerOrderGroupId} className="flex justify-between gap-3 py-2">
              <span>
                {order.orderNumber} · {order.sellerName} · {order.sellerOrderNumber}
              </span>
              <span>
                {order.effectIsSaving ? t('feeRules.saving') : t('feeRules.extra')} {formatMoney(order.effect)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
