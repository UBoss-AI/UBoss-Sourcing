/**
 * "Create preorder proposal" - the structured terms staff send when the
 * conversation has reached an understanding.
 *
 * It fills in the customer's preorder form; it binds nobody. The pieces are
 * worked out by the server from the seller's verified unit sizes, the price is
 * labelled indicative on the customer's card, and the customer still accepts
 * the preorder terms and sends the request through the ordinary preorder
 * process, where the supplier's answer is what counts.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { majorToMinor, currencyExponent } from '@/lib/format';
import {
  CHAT_ORDERING_UNITS,
  createProposal,
  type ChatOrderingUnit,
  type ConversationDetail,
} from '@/lib/preorder-chats';

export function ProposalForm({
  conversation,
  onDone,
  onCancel,
}: {
  conversation: ConversationDetail;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const request = conversation.context?.request;
  const [unit, setUnit] = useState<ChatOrderingUnit>(request?.orderingUnit ?? 'PIECE');
  const [quantity, setQuantity] = useState(String(request?.unitQuantity ?? ''));
  const [price, setPrice] = useState('');
  // The offer's currency (or the store product's), from the server.
  const currency = conversation.pricingCurrency;
  const [availability, setAvailability] = useState('');
  const [date, setDate] = useState(request?.desiredDeliveryDate ?? '');
  const [splits, setSplits] = useState('');
  const [terms, setTerms] = useState('');
  const [expiresInHours, setExpiresInHours] = useState('72');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const parsedSplits = splits
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => {
          const [day, pieces] = line.split(/[\s,;]+/);
          return { date: day ?? '', baseUnits: Number(pieces) };
        });
      return createProposal(conversation.id, {
        orderingUnit: unit,
        unitQuantity: Number(quantity),
        // The major-unit figure typed here, as minor units - never a float.
        indicativeUnitPriceMinor: price.trim() === '' ? null : majorToMinor(price.trim(), currencyExponent(currency)),
        availabilityNote: availability.trim() === '' ? null : availability.trim(),
        deliveryDate: date,
        splitDeliveries: parsedSplits,
        termsNote: terms.trim() === '' ? null : terms.trim(),
        expiresInHours: Number(expiresInHours),
      });
    },
    onSuccess: onDone,
  });

  const valid = /^\d+$/.test(quantity) && Number(quantity) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date);

  return (
    <form
      className="mt-2 space-y-2 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        setProblem(null);
        if (price.trim() !== '' && majorToMinor(price.trim(), currencyExponent(currency)) === null) {
          setProblem(t('preorderChats.proposal.badPrice'));
          return;
        }
        save.mutate();
      }}
    >
      <p className="rounded bg-brand-soft px-2 py-1 text-ink">{t('preorderChats.proposal.notBinding')}</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-ink-muted">
          {t('preorderChats.ctx.unit')}
          <select value={unit} onChange={(event) => { setUnit(event.target.value as ChatOrderingUnit); }} className="mt-0.5 block w-full rounded border border-border bg-surface px-2 py-1 text-sm text-ink">
            {CHAT_ORDERING_UNITS.map((value) => (
              <option key={value} value={value}>
                {t(`preorderChats.unit.${value}` as TranslationKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-ink-muted">
          {t('preorderChats.ctx.quantity')}
          <input inputMode="numeric" required value={quantity} onChange={(event) => { setQuantity(event.target.value.replace(/[^\d]/g, '')); }} className="mt-0.5 block w-full rounded border border-border px-2 py-1 text-sm" />
        </label>
        <label className="text-ink-muted">
          {t('preorderChats.proposal.price', { currency })}
          <input inputMode="decimal" value={price} onChange={(event) => { setPrice(event.target.value); }} className="mt-0.5 block w-full rounded border border-border px-2 py-1 text-sm" />
        </label>
        <label className="text-ink-muted">
          {t('preorderChats.ctx.date')}
          <input type="date" required value={date} onChange={(event) => { setDate(event.target.value); }} className="mt-0.5 block w-full rounded border border-border px-2 py-1 text-sm" />
        </label>
      </div>
      <label className="block text-ink-muted">
        {t('preorderChats.proposal.availability')}
        <input value={availability} maxLength={500} onChange={(event) => { setAvailability(event.target.value); }} className="mt-0.5 block w-full rounded border border-border px-2 py-1 text-sm" />
      </label>
      <label className="block text-ink-muted">
        {t('preorderChats.proposal.splits')}
        <textarea rows={2} value={splits} placeholder="2026-11-01 5000" onChange={(event) => { setSplits(event.target.value); }} className="mt-0.5 block w-full rounded border border-border px-2 py-1 text-sm" />
      </label>
      <label className="block text-ink-muted">
        {t('preorderChats.proposal.terms')}
        <textarea rows={2} value={terms} maxLength={1000} onChange={(event) => { setTerms(event.target.value); }} className="mt-0.5 block w-full rounded border border-border px-2 py-1 text-sm" />
      </label>
      <label className="block text-ink-muted">
        {t('preorderChats.proposal.expires')}
        <input inputMode="numeric" value={expiresInHours} onChange={(event) => { setExpiresInHours(event.target.value.replace(/[^\d]/g, '')); }} className="mt-0.5 block w-24 rounded border border-border px-2 py-1 text-sm" />
      </label>
      {(problem !== null || save.isError) && (
        <p role="alert" className="text-danger">
          {problem ?? errorMessage(t, save.error)}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" type="submit" variant="primary" disabled={!valid} isLoading={save.isPending}>
          {t('preorderChats.proposal.send')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
