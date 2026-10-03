/**
 * "Report" and "Translate" under a message somebody else wrote (JOURNEY-055).
 *
 * Report opens a short dialog - a reason and an optional note - and sends it
 * to the marketplace's moderators. Nothing is hidden by a report: staff look
 * at it and decide. A second report of the same message finds the first.
 *
 * Translate appears only where the marketplace switched message translation on
 * (`features.messageTranslation`). The translation is shown under the original,
 * for this reader only, with a way back to the original. Nothing is stored.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { Modal } from '@/components/Modal';
import { Button, Field, Select, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import {
  MESSAGE_REPORT_REASONS,
  reportMessage,
  translateMessage,
  type MessageAudience,
  type MessageReportReason,
  type MessageThreadKind,
} from '@/lib/message-safety';

export function MessageActions({
  threadKind,
  messageId,
  audience,
  className,
}: {
  threadKind: MessageThreadKind;
  messageId: string;
  audience: MessageAudience;
  className?: string;
}): React.JSX.Element {
  const { t, language } = useI18n();
  const { features } = useStorefront();
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState<MessageReportReason>('ABUSE');
  const [note, setNote] = useState('');
  const [reported, setReported] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);

  const report = useMutation({
    mutationFn: () =>
      reportMessage(audience, { threadKind, messageId, reason, note: note.trim() === '' ? null : note.trim() }),
    onSuccess: () => {
      setReported(true);
      setReporting(false);
    },
  });

  const translation = useMutation({
    mutationFn: () => translateMessage(audience, { threadKind, messageId, language: language.slice(0, 2) }),
    onSuccess: () => {
      setShowTranslation(true);
    },
  });

  const hasCurrentTranslation = features.messageTranslation === true && translation.data?.language === language.slice(0, 2);

  return (
    <div className={className}>
      {showTranslation && hasCurrentTranslation && translation.data !== undefined && (
        <p className="mt-1 whitespace-pre-line border-l-2 border-brand/30 pl-2 text-sm text-ink" lang={translation.data.language}>
          <span className="block text-xxs font-medium text-ink-muted">{t('messages.translate.translated')}</span>
          {translation.data.text}
        </p>
      )}
      {features.messageTranslation === true && translation.isError && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {errorMessage(t, translation.error)}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xxs">
        {features.messageTranslation === true &&
          (showTranslation && hasCurrentTranslation ? (
            <button
              type="button"
              className="font-medium text-brand hover:underline"
              onClick={() => {
                setShowTranslation(false);
              }}
            >
              {t('messages.translate.showOriginal')}
            </button>
          ) : (
            <button
              type="button"
              className="font-medium text-brand hover:underline disabled:opacity-60"
              disabled={translation.isPending}
              onClick={() => {
                if (!hasCurrentTranslation) translation.mutate();
                else setShowTranslation(true);
              }}
            >
              {translation.isPending ? t('messages.translate.working') : t('messages.translate.action')}
            </button>
          ))}
        {reported ? (
          <span role="status" className="text-ink-muted">
            {t('messages.report.sent')}
          </span>
        ) : (
          <button
            type="button"
            className="font-medium text-ink-muted hover:text-danger hover:underline"
            onClick={() => {
              setReporting(true);
            }}
          >
            {t('messages.report.action')}
          </button>
        )}
      </div>

      {reporting && (
        <Modal
          isOpen
          onClose={() => {
            setReporting(false);
          }}
          title={t('messages.report.title')}
          description={t('messages.report.description')}
          footer={
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="secondary"
                disabled={report.isPending}
                onClick={() => {
                  setReporting(false);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                isLoading={report.isPending}
                onClick={() => {
                  report.mutate();
                }}
              >
                {t('messages.report.submit')}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            {report.isError && (
              <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
                {errorMessage(t, report.error)}
              </p>
            )}
            <Field label={t('messages.report.reason')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value as MessageReportReason);
                  }}
                >
                  {MESSAGE_REPORT_REASONS.map((entry) => (
                    <option key={entry} value={entry}>
                      {t(`messages.report.reasons.${entry}` as TranslationKey)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('messages.report.note')} hint={t('messages.report.noteHint')}>
              {({ inputId }) => (
                <Textarea
                  id={inputId}
                  rows={3}
                  maxLength={1000}
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
