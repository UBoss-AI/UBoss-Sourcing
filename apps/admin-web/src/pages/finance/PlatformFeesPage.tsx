/**
 * Platform fees and the tax on them - finance only.
 *
 * What the marketplace deducts from a seller's proceeds, per scope (the
 * platform, a market, a category, one seller), versioned: a draft is edited,
 * a published version is never edited, and publishing a new one retires the
 * old one while every settlement already calculated keeps the version it was
 * calculated on.
 *
 * The tax on the fee is a CONFIGURED rate until somebody with
 * `finance.tax.verify` records that it is the legally correct one. Until then
 * the screen and every settlement call it "Tax on platform fee - configured";
 * nothing calls it GST.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, formatDate, formatMoney, majorToMinor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  createFeePolicy,
  fetchFeePolicies,
  fetchFeePolicyOrders,
  previewFee,
  publishFeePolicy,
  retireFeePolicy,
  verifyFeeTax,
  type FeePolicyInput,
  type FeePolicyView,
} from '@/lib/logistics-levels';

const KEY = ['admin', 'platform-fees'] as const;

export function PlatformFeesPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { can } = useSession();
  const mayWrite = can(Permission.FINANCE_POLICY_WRITE);
  const mayVerify = can(Permission.FINANCE_TAX_VERIFY);
  const query = useQuery({ queryKey: KEY, queryFn: fetchFeePolicies });
  const [creating, setCreating] = useState(false);
  const [publishing, setPublishing] = useState<FeePolicyView | null>(null);
  const [verifying, setVerifying] = useState<FeePolicyView | null>(null);
  const [showingOrders, setShowingOrders] = useState<FeePolicyView | null>(null);

  function refresh(): void {
    void client.invalidateQueries({ queryKey: KEY });
  }

  const publish = useMutation({
    mutationFn: (policyId: string) => publishFeePolicy(policyId),
    onSuccess: () => {
      setPublishing(null);
      toast.success(t('fees.published'));
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });
  const retire = useMutation({
    mutationFn: (policyId: string) => retireFeePolicy(policyId),
    onSuccess: () => {
      toast.success(t('fees.retired'));
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const columns: Column<FeePolicyView>[] = [
    {
      key: 'name',
      header: t('fees.column.policy'),
      render: (row) => (
        <div>
          <p className="font-medium text-ink">{row.name}</p>
          <p className="text-xxs text-ink-subtle">
            {row.scopeKey} · v{row.versionNumber}
          </p>
        </div>
      ),
    },
    {
      key: 'fee',
      header: t('fees.column.fee'),
      render: (row) => (
        <span className="text-sm text-ink">
          {row.feeType === 'FLAT' ? formatMoney(row.flatFee) : `${row.percentRate}%`}
          {row.feeType === 'PERCENT_PLUS_FLAT' && ` + ${formatMoney(row.flatFee)}`}
          <span className="block text-xxs text-ink-subtle">{t(`fees.basis.${row.feeBasis}`)}</span>
        </span>
      ),
    },
    {
      key: 'tax',
      header: t('fees.column.tax'),
      render: (row) => (
        <div>
          <p className="text-sm text-ink">{row.taxDisplayLabel}</p>
          <Badge tone={row.isTaxRuleVerified ? 'success' : 'warning'}>{row.isTaxRuleVerified ? t('fees.verified') : t('fees.unverified')}</Badge>
        </div>
      ),
    },
    {
      key: 'status',
      header: t('fees.column.status'),
      align: 'center',
      render: (row) => (
        <Badge tone={row.status === 'PUBLISHED' ? 'success' : 'neutral'}>{t(`fees.status.${row.status}`)}</Badge>
      ),
    },
    {
      key: 'from',
      header: t('fees.column.effective'),
      secondary: true,
      render: (row) => <span className="text-xs text-ink-muted">{formatDate(row.effectiveFrom)}</span>,
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <div className="flex flex-wrap justify-end gap-1.5">
          {mayWrite && row.status === 'DRAFT' && (
            <Button size="sm" variant="primary" onClick={() => { setPublishing(row); }}>
              {t('fees.publish')}
            </Button>
          )}
          {mayVerify && row.status !== 'RETIRED' && !row.isTaxRuleVerified && (
            <Button size="sm" variant="secondary" onClick={() => { setVerifying(row); }}>
              {t('fees.verify')}
            </Button>
          )}
          {mayWrite && row.status === 'PUBLISHED' && (
            <Button size="sm" variant="ghost" isLoading={retire.isPending} onClick={() => { retire.mutate(row.id); }}>
              {t('fees.retire')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => { setShowingOrders(row); }}>
            {t('fees.orders', { count: row.settlementCount })}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('fees.heading')}
        description={t('fees.intro')}
        actions={
          mayWrite ? (
            <Button variant="primary" onClick={() => { setCreating(true); }}>
              {t('fees.newDraft')}
            </Button>
          ) : undefined
        }
      />

      <Callout tone="warning">{t('fees.taxWarning')}</Callout>

      <Card>
        <DataTable
          caption={t('fees.heading')}
          columns={columns}
          rows={query.data?.policies ?? []}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
          minWidth="64rem"
          emptyTitle={t('fees.emptyTitle')}
          emptyDescription={t('fees.emptyBody')}
        />
      </Card>

      <PreviewCard />

      {creating && (
        <CreateDialog
          onClose={() => {
            setCreating(false);
          }}
          onCreated={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}

      <ConfirmDialog
        isOpen={publishing !== null}
        onClose={() => {
          setPublishing(null);
        }}
        onConfirm={() => {
          if (publishing !== null) publish.mutate(publishing.id);
        }}
        title={t('fees.publishTitle')}
        body={t('fees.publishBody')}
        confirmLabel={t('fees.publish')}
        isWorking={publish.isPending}
      />

      {verifying !== null && (
        <VerifyDialog
          policy={verifying}
          onClose={() => {
            setVerifying(null);
          }}
          onDone={() => {
            setVerifying(null);
            refresh();
          }}
        />
      )}

      {showingOrders !== null && (
        <OrdersDialog
          policy={showingOrders}
          onClose={() => {
            setShowingOrders(null);
          }}
        />
      )}
    </div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState<FeePolicyInput>({
    scope: 'GLOBAL',
    name: '',
    feeType: 'PERCENT',
    feeBasis: 'PRODUCT_SUBTOTAL',
    percentRate: '0',
    currency: 'INR',
    taxRatePercent: '15',
  });
  const [flat, setFlat] = useState('');
  const [subject, setSubject] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const exponent = currencyExponent(form.currency ?? 'INR');
      return createFeePolicy({
        ...form,
        flatFeeMinor: flat.trim() === '' ? null : majorToMinor(flat, exponent),
        ...(form.scope === 'SELLER' ? { sellerAccountId: subject.trim() } : {}),
        ...(form.scope === 'CATEGORY' ? { categoryId: subject.trim() } : {}),
        ...(form.scope === 'MARKET' ? { marketCountry: subject.trim().toUpperCase() } : {}),
      });
    },
    onSuccess: () => {
      toast.success(t('fees.draftSaved'));
      onCreated();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  function set<K extends keyof FeePolicyInput>(key: K, value: FeePolicyInput[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('fees.newDraft')}
      description={t('fees.newDraftBody')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" isLoading={create.isPending} disabled={form.name.trim().length < 2} onClick={() => { create.mutate(); }}>
            {t('fees.saveDraft')}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('fees.field.name')}>
          {({ inputId }) => <Input id={inputId} value={form.name} maxLength={160} onChange={(event) => { set('name', event.currentTarget.value); }} />}
        </Field>
        <Field label={t('fees.field.scope')}>
          {({ inputId }) => (
            <Select id={inputId} value={form.scope} onChange={(event) => { set('scope', event.currentTarget.value as FeePolicyInput['scope']); }}>
              <option value="GLOBAL">{t('fees.scope.GLOBAL')}</option>
              <option value="MARKET">{t('fees.scope.MARKET')}</option>
              <option value="CATEGORY">{t('fees.scope.CATEGORY')}</option>
              <option value="SELLER">{t('fees.scope.SELLER')}</option>
            </Select>
          )}
        </Field>
        {form.scope !== 'GLOBAL' && (
          <Field label={t(`fees.subject.${form.scope}`)}>
            {({ inputId }) => <Input id={inputId} value={subject} onChange={(event) => { setSubject(event.currentTarget.value); }} />}
          </Field>
        )}
        <Field label={t('fees.field.type')}>
          {({ inputId }) => (
            <Select id={inputId} value={form.feeType} onChange={(event) => { set('feeType', event.currentTarget.value as FeePolicyInput['feeType']); }}>
              <option value="PERCENT">{t('fees.type.PERCENT')}</option>
              <option value="FLAT">{t('fees.type.FLAT')}</option>
              <option value="PERCENT_PLUS_FLAT">{t('fees.type.PERCENT_PLUS_FLAT')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('fees.field.basis')}>
          {({ inputId }) => (
            <Select id={inputId} value={form.feeBasis} onChange={(event) => { set('feeBasis', event.currentTarget.value as FeePolicyInput['feeBasis']); }}>
              <option value="PRODUCT_SUBTOTAL">{t('fees.basis.PRODUCT_SUBTOTAL')}</option>
              <option value="PRODUCT_SUBTOTAL_PLUS_SELLER_DELIVERY">{t('fees.basis.PRODUCT_SUBTOTAL_PLUS_SELLER_DELIVERY')}</option>
            </Select>
          )}
        </Field>
        {form.feeType !== 'FLAT' && (
          <Field label={t('fees.field.percent')}>
            {({ inputId }) => <Input id={inputId} inputMode="decimal" value={form.percentRate} onChange={(event) => { set('percentRate', event.currentTarget.value); }} />}
          </Field>
        )}
        {form.feeType !== 'PERCENT' && (
          <Field label={t('fees.field.flat', { currency: form.currency ?? '' })}>
            {({ inputId }) => <Input id={inputId} inputMode="decimal" value={flat} onChange={(event) => { setFlat(event.currentTarget.value); }} />}
          </Field>
        )}
        <Field label={t('fees.field.currency')}>
          {({ inputId }) => <Input id={inputId} value={form.currency ?? ''} maxLength={3} onChange={(event) => { set('currency', event.currentTarget.value.toUpperCase()); }} />}
        </Field>
        <Field label={t('fees.field.taxRate')} hint={t('fees.field.taxRateHint')}>
          {({ inputId, describedBy }) => (
            <Input id={inputId} aria-describedby={describedBy} inputMode="decimal" value={form.taxRatePercent} onChange={(event) => { set('taxRatePercent', event.currentTarget.value); }} />
          )}
        </Field>
      </div>
    </Modal>
  );
}

function VerifyDialog({ policy, onClose, onDone }: { policy: FeePolicyView; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [note, setNote] = useState('');
  const verify = useMutation({
    mutationFn: () => verifyFeeTax(policy.id, note.trim()),
    onSuccess: () => {
      toast.success(t('fees.verifiedToast'));
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
      title={t('fees.verifyTitle', { name: policy.name })}
      description={t('fees.verifyBody', { rate: policy.taxRatePercent })}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={note.trim().length < 10} isLoading={verify.isPending} onClick={() => { verify.mutate(); }}>
            {t('fees.verify')}
          </Button>
        </div>
      }
    >
      <Field label={t('fees.verifyNote')} hint={t('fees.verifyNoteHint')}>
        {({ inputId, describedBy }) => (
          <Textarea id={inputId} aria-describedby={describedBy} rows={3} value={note} maxLength={512} onChange={(event) => { setNote(event.currentTarget.value); }} />
        )}
      </Field>
    </Modal>
  );
}

function OrdersDialog({ policy, onClose }: { policy: FeePolicyView; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: [...KEY, policy.id, 'orders'], queryFn: () => fetchFeePolicyOrders(policy.id) });
  return (
    <Modal isOpen onClose={onClose} title={t('fees.ordersTitle', { name: policy.name, version: String(policy.versionNumber) })}>
      {query.isPending ? (
        <p className="text-sm text-ink-muted">{t('levels.loading')}</p>
      ) : (query.data?.orders.length ?? 0) === 0 ? (
        <p className="text-sm text-ink-muted">{t('fees.noOrders')}</p>
      ) : (
        <ul className="divide-y divide-border-subtle text-sm">
          {query.data?.orders.map((order) => (
            <li key={order.sellerOrderGroupId} className="flex justify-between gap-3 py-2">
              <span>
                {order.orderNumber} · {order.sellerName} · {order.sellerOrderNumber}
              </span>
              <span>
                {formatMoney(order.platformFee)} + {formatMoney(order.platformFeeTax)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function PreviewCard(): React.JSX.Element {
  const { t } = useI18n();
  const [sellerAccountId, setSellerAccountId] = useState('');
  const [goods, setGoods] = useState('10000');
  const [delivery, setDelivery] = useState('0');
  const [currency, setCurrency] = useState('INR');
  const preview = useMutation({
    mutationFn: () =>
      previewFee({
        sellerAccountId: sellerAccountId.trim(),
        goodsMinor: majorToMinor(goods, currencyExponent(currency)) ?? '0',
        sellerDeliveryMinor: majorToMinor(delivery, currencyExponent(currency)) ?? '0',
        currency,
      }),
  });
  const estimate = preview.data?.estimate;

  return (
    <Card title={t('fees.previewTitle')} description={t('fees.previewBody')}>
      <div className="space-y-4 px-5 pb-5">
        <div className="grid gap-3 sm:grid-cols-5">
          <Field label={t('fees.previewSeller')}>
            {({ inputId }) => <Input id={inputId} value={sellerAccountId} maxLength={26} onChange={(event) => { setSellerAccountId(event.currentTarget.value); }} />}
          </Field>
          <Field label={t('fees.previewGoods')}>
            {({ inputId }) => <Input id={inputId} inputMode="decimal" value={goods} onChange={(event) => { setGoods(event.currentTarget.value); }} />}
          </Field>
          <Field label={t('fees.previewDelivery')}>
            {({ inputId }) => <Input id={inputId} inputMode="decimal" value={delivery} onChange={(event) => { setDelivery(event.currentTarget.value); }} />}
          </Field>
          <Field label={t('fees.field.currency')}>
            {({ inputId }) => <Input id={inputId} value={currency} maxLength={3} onChange={(event) => { setCurrency(event.currentTarget.value.toUpperCase()); }} />}
          </Field>
          <div className="flex items-end">
            <Button variant="secondary" disabled={sellerAccountId.trim().length !== 26} isLoading={preview.isPending} onClick={() => { preview.mutate(); }}>
              {t('fees.previewRun')}
            </Button>
          </div>
        </div>
        {preview.isError && <Callout tone="danger">{errorMessage(t, preview.error)}</Callout>}
        {estimate !== undefined && (
          <dl className="grid gap-2 text-sm sm:grid-cols-5">
            <div><dt className="text-ink-muted">{t('fees.gross')}</dt><dd className="text-ink">{formatMoney(estimate.grossProceeds)}</dd></div>
            <div><dt className="text-ink-muted">{t('fees.sellerDelivery')}</dt><dd className="text-ink">+ {formatMoney(estimate.sellerDeliveryProceeds)}</dd></div>
            <div><dt className="text-ink-muted">{t('fees.platformFee')}</dt><dd className="text-ink">− {formatMoney(estimate.platformFee)}</dd></div>
            <div><dt className="text-ink-muted">{estimate.feeTaxLabel}</dt><dd className="text-ink">− {formatMoney(estimate.platformFeeTax)}</dd></div>
            <div><dt className="font-semibold text-ink">{t('fees.settlement')}</dt><dd className="font-semibold text-ink">{formatMoney(estimate.estimatedSettlement)}</dd></div>
          </dl>
        )}
      </div>
    </Card>
  );
}
