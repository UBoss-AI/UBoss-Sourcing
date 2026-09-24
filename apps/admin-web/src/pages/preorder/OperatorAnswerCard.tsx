/**
 * Staff answering a preorder on the OPERATOR's own product.
 *
 * On a seller's preorder the admin page is read-only; this card only appears
 * where the store itself is the supplier (`supplier === 'OPERATOR'`) and the
 * member of staff may move orders through fulfilment (`order.fulfil`). What it
 * offers comes from the server's `allowedActions` for the supplier's role, so
 * the card can never offer a step the state machine would refuse.
 *
 * Accepting keeps the buyer's quantity, date and the price they were shown
 * (or, when it was quoted, the price staff enter). Changing any of those is a
 * counter-offer, which the buyer then confirms or declines.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useToast } from '@/components/toast-context';
import { Button, Card, Field, Input, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { majorToMinor, minorToMajor } from '@/lib/format';
import type { Money } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';

export interface AnswerablePreorder {
  id: string;
  version: number;
  allowedActions: string[];
  pricingMode: 'FIXED' | 'QUOTE_REQUIRED';
  currency: string;
  quantity: { baseUnits: number };
  requestedDeliveryDate: string;
  indicative: { unitPrice: Money | null };
}

type Mode = 'accept' | 'counter' | 'reject' | null;

export function OperatorAnswerCard({
  preorder,
  exponent,
}: {
  preorder: AnswerablePreorder;
  exponent: number;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [mode, setMode] = useState<Mode>(null);
  const [price, setPrice] = useState(
    preorder.indicative.unitPrice === null
      ? ''
      : minorToMajor(preorder.indicative.unitPrice.minor, exponent),
  );
  const [freight, setFreight] = useState('0');
  const [quantity, setQuantity] = useState(String(preorder.quantity.baseUnits));
  const [date, setDate] = useState(preorder.requestedDeliveryDate);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const can = (to: string): boolean => preorder.allowedActions.includes(to);
  const done = async (): Promise<void> => {
    setMode(null);
    setProblem(null);
    await client.invalidateQueries({ queryKey: ['admin', 'preorder', preorder.id] });
    toast.success(t('preorders.answer.saved'));
  };

  const act = useMutation({
    mutationFn: async (kind: 'accept' | 'counter' | 'reject' | 'production' | 'ready') => {
      const base = `/admin/preorders/${preorder.id}`;
      if (kind === 'production') return api.post(`${base}/start-production`, { note: null });
      if (kind === 'ready') return api.post(`${base}/ready`, { note: null });
      if (kind === 'reject') {
        return api.post(`${base}/reject`, {
          reason: text.trim(),
          expectedVersion: preorder.version,
        });
      }
      const freightMinor = majorToMinor(freight, exponent);
      const priceMinor = majorToMinor(price, exponent);
      if (freightMinor === null || (kind === 'counter' && priceMinor === null)) {
        throw new Error(t('preorders.answer.amountInvalid'));
      }
      if (kind === 'accept') {
        return api.post(`${base}/accept`, {
          // Quoted: staff state the price. Fixed: the buyer's price stands.
          unitPriceMinor: preorder.pricingMode === 'QUOTE_REQUIRED' ? priceMinor : null,
          freightMinor,
          committedDeliveryDate: null,
          originLocationId: null,
          note: text.trim() === '' ? null : text.trim(),
          expectedVersion: preorder.version,
        });
      }
      return api.post(`${base}/counter`, {
        quantityBaseUnits: Number(quantity),
        unitPriceMinor: priceMinor,
        freightMinor,
        committedDeliveryDate: date,
        deliverySplits: null,
        originLocationId: null,
        note: text.trim() === '' ? null : text.trim(),
        expectedVersion: preorder.version,
      });
    },
    onSuccess: done,
    onError: (error) => {
      setProblem(errorMessage(t, error));
    },
  });

  const answering = can('SELLER_ACCEPTED') || can('SELLER_COUNTERED') || can('REJECTED');
  if (!answering && !can('IN_PRODUCTION') && !can('READY_FOR_FULFILLMENT')) return null;

  return (
    <Card
      title={t('preorders.answer.title')}
      description={t('preorders.answer.intro')}
      bodyClassName="space-y-3 px-5 py-4"
    >
      <div className="flex flex-wrap gap-2">
        {can('SELLER_ACCEPTED') && (
          <Button
            size="sm"
            variant={mode === 'accept' ? 'primary' : 'secondary'}
            onClick={() => {
              setMode('accept');
            }}
          >
            {t('preorders.answer.accept')}
          </Button>
        )}
        {can('SELLER_COUNTERED') && (
          <Button
            size="sm"
            variant={mode === 'counter' ? 'primary' : 'secondary'}
            onClick={() => {
              setMode('counter');
            }}
          >
            {t('preorders.answer.counter')}
          </Button>
        )}
        {can('REJECTED') && (
          <Button
            size="sm"
            variant={mode === 'reject' ? 'danger' : 'ghost'}
            onClick={() => {
              setMode('reject');
            }}
          >
            {t('preorders.answer.reject')}
          </Button>
        )}
        {can('IN_PRODUCTION') && (
          <Button
            size="sm"
            variant="primary"
            isLoading={act.isPending}
            onClick={() => {
              act.mutate('production');
            }}
          >
            {t('preorders.answer.startProduction')}
          </Button>
        )}
        {can('READY_FOR_FULFILLMENT') && (
          <Button
            size="sm"
            variant="primary"
            isLoading={act.isPending}
            onClick={() => {
              act.mutate('ready');
            }}
          >
            {t('preorders.answer.ready')}
          </Button>
        )}
      </div>

      {(mode === 'accept' || mode === 'counter') && (
        <div className="space-y-3">
          {mode === 'counter' && (
            <Field label={t('preorders.answer.quantity')} required>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  inputMode="numeric"
                  value={quantity}
                  onChange={(event) => {
                    setQuantity(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
          )}
          {(mode === 'counter' || preorder.pricingMode === 'QUOTE_REQUIRED') && (
            <Field label={t('preorders.answer.price', { currency: preorder.currency })} required>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  inputMode="decimal"
                  value={price}
                  onChange={(event) => {
                    setPrice(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
          )}
          <Field
            label={t('preorders.answer.freight', { currency: preorder.currency })}
            hint={t('preorders.answer.freightHint')}
            required
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                inputMode="decimal"
                value={freight}
                onChange={(event) => {
                  setFreight(event.currentTarget.value);
                }}
              />
            )}
          </Field>
          {mode === 'counter' && (
            <Field label={t('preorders.answer.date')} required>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  type="date"
                  value={date}
                  onChange={(event) => {
                    setDate(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
          )}
          <Field label={t('preorders.answer.note')}>
            {({ inputId }) => (
              <Textarea
                id={inputId}
                rows={2}
                value={text}
                onChange={(event) => {
                  setText(event.currentTarget.value);
                }}
              />
            )}
          </Field>
          <Button
            variant="primary"
            size="sm"
            isLoading={act.isPending}
            onClick={() => {
              act.mutate(mode);
            }}
          >
            {mode === 'accept'
              ? t('preorders.answer.sendAccept')
              : t('preorders.answer.sendCounter')}
          </Button>
        </div>
      )}

      {mode === 'reject' && (
        <div className="space-y-3">
          <Field label={t('preorders.answer.reason')} required>
            {({ inputId }) => (
              <Textarea
                id={inputId}
                rows={2}
                value={text}
                onChange={(event) => {
                  setText(event.currentTarget.value);
                }}
              />
            )}
          </Field>
          <Button
            variant="danger"
            size="sm"
            isLoading={act.isPending}
            disabled={text.trim().length < 3}
            onClick={() => {
              act.mutate('reject');
            }}
          >
            {t('preorders.answer.sendReject')}
          </Button>
        </div>
      )}

      {problem !== null && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
    </Card>
  );
}
