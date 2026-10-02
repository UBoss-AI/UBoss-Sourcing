/**
 * Messages about an order, between the buyer and a seller (JOURNEY-055).
 *
 * The buyer sees one thread per seller on the order, picked by a row of
 * buttons when there is more than one; a seller sees its own thread only.
 * Polls every 30 seconds for messages after the newest it holds and merges
 * by id, so nothing is shown twice. Each send carries its own id, so a double
 * press on a bad line is one message.
 *
 * Renders nothing on an order with no seller parts - the marketplace's own
 * stock - because there is nobody here to write to; support is for that.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Card, ErrorState, Field, LoadingState, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import {
  fetchBuyerOrderThreads,
  fetchSellerOrderThread,
  newClientMessageId,
  postBuyerOrderMessage,
  postSellerOrderMessage,
  type OrderMessage,
  type OrderThread,
} from '@/lib/order-messages';
import { MessageActions } from './MessageActions';
import { SensitiveDataNotice } from './SensitiveDataNotice';

export const ORDER_MESSAGE_POLL_MS = 30_000;

type PanelProps = { audience: 'buyer'; orderId: string } | { audience: 'seller'; groupId: string };

function mergeMessages(current: OrderMessage[], incoming: OrderMessage[]): OrderMessage[] {
  const seen = new Set(current.map((message) => message.id));
  return [...current, ...incoming.filter((message) => !seen.has(message.id))].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function OrderMessagesPanel(props: PanelProps): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const key = props.audience === 'buyer' ? props.orderId : props.groupId;
  const load = (after?: string): Promise<OrderThread[]> =>
    props.audience === 'buyer'
      ? fetchBuyerOrderThreads(props.orderId, after)
      : fetchSellerOrderThread(props.groupId, after).then((thread) => [thread]);

  const initial = useQuery({ queryKey: ['order-messages', props.audience, key], queryFn: () => load() });
  const [threads, setThreads] = useState<OrderThread[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const clientId = useRef(newClientMessageId());

  const merge = (incoming: OrderThread[]): void => {
    setThreads((current) => {
      const byId = new Map(current.map((thread) => [thread.sellerOrderGroupId, thread]));
      for (const thread of incoming) {
        const existing = byId.get(thread.sellerOrderGroupId);
        byId.set(
          thread.sellerOrderGroupId,
          existing === undefined ? thread : { ...existing, messages: mergeMessages(existing.messages, thread.messages) },
        );
      }
      return [...byId.values()];
    });
  };

  useEffect(() => {
    if (initial.data !== undefined) merge(initial.data);
  }, [initial.data]);

  const newest = useMemo(
    () =>
      threads
        .flatMap((thread) => thread.messages.map((message) => message.id))
        .sort()
        .at(-1),
    [threads],
  );

  useEffect(() => {
    if (initial.data === undefined) return undefined;
    const timer = window.setInterval(() => {
      load(newest)
        .then((incoming) => {
          merge(incoming);
        })
        .catch(() => undefined);
    }, ORDER_MESSAGE_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
    // Re-armed whenever the newest id moves, so `after` is always current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, newest, initial.data]);

  const active = threads.find((thread) => thread.sellerOrderGroupId === selected) ?? threads[0];

  const send = useMutation({
    mutationFn: (input: { groupId: string; body: string }) =>
      props.audience === 'buyer'
        ? postBuyerOrderMessage(props.orderId, input.groupId, input.body, clientId.current)
        : postSellerOrderMessage(input.groupId, input.body, clientId.current),
    onSuccess: (message, input) => {
      merge([{ ...(threads.find((thread) => thread.sellerOrderGroupId === input.groupId) as OrderThread), messages: [message] }]);
      setDraft('');
      clientId.current = newClientMessageId();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  if (initial.isPending) return <LoadingState label={t('orderMessages.loading')} />;
  if (initial.isError) {
    return (
      <ErrorState
        error={initial.error}
        onRetry={() => {
          void initial.refetch();
        }}
      />
    );
  }
  if (active === undefined) return null;

  const otherParty = props.audience === 'buyer' ? active.sellerName : t('orderMessages.buyer');

  return (
    <Card bodyClassName="space-y-4 px-6 py-5">
      <div>
        <h2 className="text-base font-semibold text-ink">{t('orderMessages.title')}</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          {props.audience === 'buyer' ? t('orderMessages.buyerHint') : t('orderMessages.sellerHint')}
        </p>
      </div>

      {props.audience === 'buyer' && threads.length > 1 && (
        <div role="group" aria-label={t('orderMessages.pickSeller')} className="flex flex-wrap gap-2">
          {threads.map((thread) => (
            <Button
              key={thread.sellerOrderGroupId}
              size="sm"
              variant={thread.sellerOrderGroupId === active.sellerOrderGroupId ? 'primary' : 'secondary'}
              aria-pressed={thread.sellerOrderGroupId === active.sellerOrderGroupId}
              onClick={() => {
                setSelected(thread.sellerOrderGroupId);
              }}
            >
              {thread.sellerName}
            </Button>
          ))}
        </div>
      )}

      {active.messages.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('orderMessages.empty', { name: otherParty })}</p>
      ) : (
        <ol className="space-y-3" aria-label={t('orderMessages.threadLabel', { name: otherParty })} aria-live="polite">
          {active.messages.map((message) => (
            <li
              key={message.id}
              className={cx(
                'rounded-md px-3 py-2',
                message.mine ? 'ml-6 bg-brand/10' : 'mr-6 bg-surface-sunken',
              )}
            >
              <p className="text-xs font-medium text-ink-muted">
                {message.mine ? t('orderMessages.you') : otherParty} · {formatDateTime(message.at)}
              </p>
              <p className="mt-1 whitespace-pre-line text-sm text-ink [overflow-wrap:anywhere]">{message.body}</p>
              {!message.mine && <MessageActions threadKind="ORDER" messageId={message.id} audience={props.audience} />}
            </li>
          ))}
        </ol>
      )}

      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim().length > 0) send.mutate({ groupId: active.sellerOrderGroupId, body: draft.trim() });
        }}
      >
        <SensitiveDataNotice draft={draft} />
        <Field label={t('orderMessages.write', { name: otherParty })}>
          {({ inputId }) => (
            <Textarea
              id={inputId}
              rows={3}
              maxLength={4000}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" isLoading={send.isPending} disabled={draft.trim().length === 0}>
          {t('orderMessages.send')}
        </Button>
      </form>
    </Card>
  );
}
