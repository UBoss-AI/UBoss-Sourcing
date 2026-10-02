/**
 * Seller fee tiers - the part of Finance -> Fee rules that says which tier a
 * seller is in (checklist JOURNEY-054).
 *
 * A SELLER_TIER fee rule applies to every seller in its tier. This card is
 * where finance puts a seller in a tier, moves them, or takes them out, and
 * each change needs a reason of at least ten characters, which goes on the
 * audit trail. Only the seller's NEXT orders change: a settlement already
 * worked out is never recalculated. The server checks the permission and the
 * reason again.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, Input, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { fetchSellerFeeTiers, setSellerFeeTier, type SellerFeeTier } from '@/lib/fee-rules';

const KEY = ['admin', 'seller-fee-tiers'] as const;
const TIER_FORMAT = /^[A-Z0-9_-]{1,32}$/;

export function SellerFeeTiers({ mayWrite }: { mayWrite: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<SellerFeeTier | null>(null);
  const tiered = useQuery({ queryKey: [...KEY, 'tiered'], queryFn: () => fetchSellerFeeTiers() });
  const term = search.trim();
  const found = useQuery({
    queryKey: [...KEY, 'search', term],
    queryFn: () => fetchSellerFeeTiers(term),
    enabled: mayWrite && term.length >= 2,
  });

  const row = (seller: SellerFeeTier): React.JSX.Element => (
    <li key={seller.sellerAccountId} className="flex flex-wrap items-center justify-between gap-3 py-2">
      <span className="text-sm text-ink">
        {seller.displayName}{' '}
        {seller.feeTier === null ? (
          <Badge tone="neutral">{t('feeRules.tiers.none')}</Badge>
        ) : (
          <Badge tone="brand">{seller.feeTier}</Badge>
        )}
      </span>
      {mayWrite && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setEditing(seller);
          }}
        >
          {seller.feeTier === null ? t('feeRules.tiers.place') : t('feeRules.tiers.change')}
        </Button>
      )}
    </li>
  );

  const sellers = tiered.data?.sellers ?? [];
  return (
    <Card title={t('feeRules.tiers.heading')} description={t('feeRules.tiers.intro')}>
      <div className="space-y-4">
        {tiered.isPending ? (
          <p className="text-sm text-ink-muted">{t('feeRules.tiers.loading')}</p>
        ) : sellers.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('feeRules.tiers.empty')}</p>
        ) : (
          <ul className="divide-y divide-border-subtle" aria-label={t('feeRules.tiers.heading')}>
            {sellers.map(row)}
          </ul>
        )}

        {mayWrite && (
          <div className="space-y-2">
            <Field label={t('feeRules.tiers.find')} hint={t('feeRules.tiers.findHint')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  type="search"
                  maxLength={120}
                  value={search}
                  onChange={(event) => {
                    setSearch(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
            {term.length >= 2 && found.data !== undefined && (
              found.data.sellers.length === 0 ? (
                <p className="text-sm text-ink-muted">{t('feeRules.tiers.noMatch')}</p>
              ) : (
                <ul className="divide-y divide-border-subtle" aria-label={t('feeRules.tiers.results')}>
                  {found.data.sellers.map(row)}
                </ul>
              )
            )}
          </div>
        )}
      </div>

      {editing !== null && (
        <TierDialog
          seller={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </Card>
  );
}

function TierDialog({ seller, onClose }: { seller: SellerFeeTier; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [tier, setTier] = useState(seller.feeTier ?? '');
  const [reason, setReason] = useState('');
  const normalised = tier.trim().toUpperCase();
  const tierValid = normalised === '' || TIER_FORMAT.test(normalised);
  const unchanged = (normalised === '' ? null : normalised) === seller.feeTier;
  const save = useMutation({
    mutationFn: () => setSellerFeeTier(seller.sellerAccountId, normalised === '' ? null : normalised, reason.trim()),
    onSuccess: () => {
      toast.success(t('feeRules.tiers.saved', { seller: seller.displayName }));
      void client.invalidateQueries({ queryKey: KEY });
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('feeRules.tiers.dialogTitle', { seller: seller.displayName })}
      description={t('feeRules.tiers.dialogBody')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!tierValid || unchanged || reason.trim().length < 10}
            isLoading={save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            {t('feeRules.tiers.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field
          label={t('feeRules.tiers.tier')}
          hint={t('feeRules.tiers.tierHint')}
          error={tierValid ? undefined : t('feeRules.tiers.tierFormat')}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              maxLength={32}
              value={tier}
              onChange={(event) => {
                setTier(event.currentTarget.value);
              }}
            />
          )}
        </Field>
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
      </div>
    </Modal>
  );
}
