/**
 * The HSN code and country of origin on one listing.
 *
 * Both are printed on every GST invoice and packing list for this product,
 * and an Indian tax invoice cannot be issued without the HSN code. They live
 * on the listing because they describe the goods, and the seller knows them
 * when they list - not at the packing bench with a van waiting.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useToast } from '@/components/toast-context';
import { Button, Card, Field, Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { fetchTradeCodes, saveTradeCodes } from '@/lib/seller-documents';

export function SellerTradeCodesPanel({ offerId }: { offerId: string }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const key = ['seller', 'offer', offerId, 'trade-codes'];
  const query = useQuery({ queryKey: key, queryFn: () => fetchTradeCodes(offerId) });
  const [hsn, setHsn] = useState('');
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    if (query.data === undefined) return;
    setHsn(query.data.hsnCode ?? '');
    setOrigin(query.data.countryOfOrigin ?? '');
  }, [query.data]);

  const save = useMutation({
    mutationFn: () =>
      saveTradeCodes(offerId, {
        hsnCode: hsn.trim() === '' ? null : hsn.trim(),
        countryOfOrigin: origin.trim() === '' ? null : origin.trim().toUpperCase(),
      }),
    onSuccess: (saved) => {
      client.setQueryData(key, saved);
      toast.success(t('tradeCodes.saved'));
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const hsnInvalid = hsn.trim() !== '' && !/^\d{4,10}$/.test(hsn.trim());
  const originInvalid = origin.trim() !== '' && !/^[A-Za-z]{2}$/.test(origin.trim());

  return (
    <Card
      title={t('tradeCodes.title')}
      description={t('tradeCodes.intro')}
      bodyClassName="px-6 py-5"
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field
          label={t('tradeCodes.hsn')}
          hint={t('tradeCodes.hsnHint')}
          error={hsnInvalid ? t('tradeCodes.hsnInvalid') : undefined}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              inputMode="numeric"
              maxLength={10}
              disabled={query.isPending}
              value={hsn}
              onChange={(event) => {
                setHsn(event.currentTarget.value);
              }}
            />
          )}
        </Field>
        <Field
          label={t('tradeCodes.origin')}
          hint={t('tradeCodes.originHint')}
          error={originInvalid ? t('tradeCodes.originInvalid') : undefined}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              maxLength={2}
              disabled={query.isPending}
              value={origin}
              onChange={(event) => {
                setOrigin(event.currentTarget.value.toUpperCase());
              }}
            />
          )}
        </Field>
        <Button
          isLoading={save.isPending}
          disabled={hsnInvalid || originInvalid || query.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          {t('tradeCodes.save')}
        </Button>
      </div>
    </Card>
  );
}
