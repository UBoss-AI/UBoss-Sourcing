/**
 * One question-and-answer thread on a request for quotation: the buyer with
 * one seller. Used on both sides.
 *
 * It polls for new messages every 15 seconds while open, asking only for
 * those after the last one it holds, and merges by id - so a message is
 * never shown twice. Each send carries its own id, so pressing Send twice on
 * a bad line is still one message.
 *
 * JOURNEY-055: a message may point at one file already on the request
 * (`attachableFiles`), each message from the other side carries Report and,
 * where switched on, Translate, and the composer warns against sending bank
 * or card details.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, ErrorState, Field, LoadingState, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { api, newIdempotencyKey } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatUtc } from '@/lib/rfq-format';
import { MessageActions } from '@/components/messages/MessageActions';
import { SensitiveDataNotice } from '@/components/messages/SensitiveDataNotice';

export interface RfqMessage {
  id: string;
  from: 'BUYER' | 'SUPPLIER';
  body: string;
  mine: boolean;
  at: string;
  /** The file the message points at. Absent from an older API. */
  attachment?: { id: string; fileName: string; contentType: string; byteSize: number } | null;
}

export function RfqThread({
  path,
  canWrite,
  otherPartyName,
  audience = 'buyer',
  attachableFiles = [],
  attachmentHref,
}: {
  /** The thread's messages route, e.g. `/rfqs/:id/invitations/:invitationId/messages`. */
  path: string;
  canWrite: boolean;
  otherPartyName: string;
  /** Whose session reads it: decides where Report and Translate are sent. */
  audience?: 'buyer' | 'seller';
  /** Files on the request this writer may point a message at. */
  attachableFiles?: readonly { id: string; fileName: string }[];
  /** The download link of a file on this request, for a message's attachment. */
  attachmentHref?: (attachmentId: string) => string;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const [messages, setMessages] = useState<RfqMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [attachmentId, setAttachmentId] = useState('');
  const clientId = useRef(newIdempotencyKey());
  const last = messages.at(-1)?.id;

  const merge = (incoming: RfqMessage[]): void => {
    setMessages((current) => {
      const seen = new Set(current.map((message) => message.id));
      return [...current, ...incoming.filter((message) => !seen.has(message.id))].sort((a, b) => (a.id < b.id ? -1 : 1));
    });
  };

  const initial = useQuery({
    queryKey: ['rfq-thread', path],
    queryFn: () => api.get<{ messages: RfqMessage[] }>(path),
  });
  useEffect(() => {
    if (initial.data !== undefined) merge(initial.data.messages);
  }, [initial.data]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void api
        .get<{ messages: RfqMessage[] }>(path, { query: { after: last } })
        .then((result) => {
          merge(result.messages);
        })
        .catch(() => undefined);
    }, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [path, last]);

  const send = useMutation({
    mutationFn: () =>
      api.post<{ message: RfqMessage }>(path, {
        body: draft.trim(),
        clientMessageId: clientId.current.replace(/[^A-Za-z0-9_-]/g, ''),
        ...(attachmentId === '' ? {} : { attachmentId }),
      }),
    onSuccess: (result) => {
      merge([result.message]);
      setDraft('');
      setAttachmentId('');
      clientId.current = newIdempotencyKey();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  if (initial.isPending) return <LoadingState label={t('rfq.thread.loading')} />;
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

  return (
    <div className="space-y-4">
      {messages.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('rfq.thread.empty')}</p>
      ) : (
        <ol className="space-y-3" aria-label={t('rfq.thread.label', { name: otherPartyName })} aria-live="polite">
          {messages.map((message) => (
            <li
              key={message.id}
              className={message.mine ? 'ml-6 rounded-md bg-brand/10 px-3 py-2' : 'mr-6 rounded-md bg-surface-sunken px-3 py-2'}
            >
              <p className="text-xs font-medium text-ink-muted">
                {message.mine ? t('rfq.thread.you') : otherPartyName} · {formatUtc(message.at, intlLocale)}
              </p>
              <p className="mt-1 whitespace-pre-line text-sm text-ink">{message.body}</p>
              {message.attachment != null && (
                <p className="mt-1 text-xs">
                  {attachmentHref === undefined ? (
                    <span className="text-ink-muted">{message.attachment.fileName}</span>
                  ) : (
                    <a href={attachmentHref(message.attachment.id)} className="font-medium text-brand hover:underline">
                      {t('messages.attachment.download', { name: message.attachment.fileName })}
                    </a>
                  )}
                </p>
              )}
              {!message.mine && <MessageActions threadKind="RFQ" messageId={message.id} audience={audience} />}
            </li>
          ))}
        </ol>
      )}
      {canWrite ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim().length > 0) send.mutate();
          }}
          className="space-y-2"
        >
          <SensitiveDataNotice draft={draft} />
          <Field label={t('rfq.thread.write')}>
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
          {attachableFiles.length > 0 && (
            <Field label={t('messages.attachment.pick')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={attachmentId}
                  onChange={(event) => {
                    setAttachmentId(event.target.value);
                  }}
                >
                  <option value="">{t('messages.attachment.none')}</option>
                  {attachableFiles.map((file) => (
                    <option key={file.id} value={file.id}>
                      {file.fileName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Button type="submit" variant="primary" isLoading={send.isPending} disabled={draft.trim().length === 0}>
            {t('rfq.thread.send')}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-ink-muted">{t('rfq.thread.closed')}</p>
      )}
    </div>
  );
}
