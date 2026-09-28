/**
 * Raise a ticket - the card on the Support page.
 *
 * ONLY THE ISSUE
 *
 * The person describes the problem and nothing else: a topic, a subject, the
 * details, and an order number if it is about one. Who they are is already
 * known - the server takes the name, the account email (where replies go) and
 * the company or seller they are acting for from the session - so none of it
 * is a field here. One line says whose name the ticket goes in, so nobody
 * wonders where the reply will arrive.
 *
 * SENDING ONCE
 *
 * One idempotency key per attempt, made when the form mounts and replaced only
 * after a confirmed success. A double-click, or a retry after a network drop
 * whose answer never arrived, repeats the same key and the server answers with
 * the ticket it already made. A synchronous guard also drops a second click
 * that lands before React has disabled the button.
 *
 * WHEN IT FAILS
 *
 * Everything typed stays. A refusal naming a field is put on that field; any
 * other refusal is said once above the button, in the reader's language.
 */
import { useId, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { Button, ErrorSummary, Field, Input, Select, Textarea } from '@/components/ui';
import { AlertIcon, SendIcon, UserIcon } from '@/components/icons';
import { ApiError, newIdempotencyKey } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import {
  SUPPORT_CATEGORIES,
  createSupportTicket,
  uploadSupportAttachment,
  type SupportCategory,
  type SupportContext,
  type SupportSurface,
  type SupportTicket,
} from '@/lib/support';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { SupportFilePicker, type PickedFile } from './SupportFilePicker';

const FIELDS = ['category', 'subject', 'orderNumber', 'message'] as const;
type FieldName = (typeof FIELDS)[number];

function isFieldName(value: string | undefined): value is FieldName {
  return FIELDS.includes(value as FieldName);
}

/** What happened to each chosen file, for the confirmation. */
export interface SupportFileOutcome {
  name: string;
  ok: boolean;
  message: string | null;
}

export interface SupportSentResult {
  ticket: SupportTicket;
  acknowledgementQueued: boolean;
  files: SupportFileOutcome[];
}

export interface SupportRequestFormProps {
  surface: SupportSurface;
  context: SupportContext;
  /** From `?order=` when a page sent the reader here about one order. */
  initialOrderNumber?: string | null;
  initialCategory?: SupportCategory | null;
  onSent: (result: SupportSentResult) => void;
}

export function SupportRequestForm({
  surface,
  context,
  initialOrderNumber,
  initialCategory,
  onSent,
}: SupportRequestFormProps): React.JSX.Element {
  const { t, language } = useI18n();
  const { requester, limits } = context;
  const statusId = useId();
  const attemptKey = useRef(newIdempotencyKey());
  // Set synchronously on the first click, so a second click that lands before
  // React has re-rendered the disabled button sends nothing.
  const inFlight = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [files, setFiles] = useState<PickedFile[]>([]);
  // Which file is on its way, for the button and the live region.
  const [uploading, setUploading] = useState<{ index: number; total: number } | null>(null);
  const fileRules = context.attachments;

  const schema = useMemo(
    () =>
      z.object({
        category: z.enum(SUPPORT_CATEGORIES, { message: t('support.form.error.categoryRequired') }),
        subject: z
          .string()
          .trim()
          .min(limits.subjectMin, t('support.form.error.subjectRequired'))
          .max(
            limits.subjectMax,
            t('support.form.error.tooLong', { max: String(limits.subjectMax) }),
          ),
        orderNumber: z
          .string()
          .trim()
          .max(
            limits.orderNumberMax,
            t('support.form.error.tooLong', { max: String(limits.orderNumberMax) }),
          ),
        message: z
          .string()
          .trim()
          .min(
            limits.messageMin,
            t('support.form.error.messageTooShort', { min: String(limits.messageMin) }),
          )
          .max(
            limits.messageMax,
            t('support.form.error.tooLong', { max: String(limits.messageMax) }),
          ),
      }),
    [t, limits],
  );

  type Values = z.input<typeof schema>;

  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitted },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      // An empty choice, so nobody files under "Orders" because it was first.
      category: (initialCategory ?? '') as SupportCategory,
      subject: '',
      orderNumber: initialOrderNumber ?? '',
      message: '',
    },
  });

  // Code points, the way the server counts: an emoji is one character to both.
  const messageLength = Array.from(watch('message')).length;

  const send = useMutation({
    mutationFn: (values: z.output<typeof schema>) =>
      createSupportTicket(
        surface,
        {
          category: values.category,
          subject: values.subject,
          message: values.message,
          orderNumber:
            requester.canReferenceOrder && values.orderNumber.length > 0
              ? values.orderNumber
              : null,
          language,
        },
        attemptKey.current,
      ),
    onMutate: () => {
      setProblem(null);
    },
    onSuccess: async (result) => {
      // Only now: a new ticket gets a new key.
      attemptKey.current = newIdempotencyKey();

      // The ticket exists; its files follow one at a time, so one refused file
      // (too large, the wrong kind) costs nothing but itself. Each outcome is
      // reported on the confirmation, where the ticket page can take a retry.
      const outcomes: SupportFileOutcome[] = [];
      for (const [index, picked] of files.entries()) {
        setUploading({ index: index + 1, total: files.length });
        try {
          await uploadSupportAttachment(surface, result.ticket.reference, picked.file);
          outcomes.push({ name: picked.file.name, ok: true, message: null });
        } catch (error) {
          outcomes.push({
            name: picked.file.name,
            ok: false,
            message: errorMessage(t, error, t('support.files.failed')),
          });
        }
      }
      setUploading(null);
      onSent({ ...result, files: outcomes });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        let placed = false;
        for (const detail of error.details) {
          if (isFieldName(detail.field)) {
            setError(detail.field, {
              type: 'server',
              message: fieldMessage(detail.field, detail.code),
            });
            placed = true;
          }
        }
        if (placed) return;
      }
      setProblem(errorMessage(t, error, t('support.form.error.generic')));
    },
  });

  function fieldMessage(field: FieldName, code: string | undefined): string {
    if (field === 'orderNumber') return t('support.form.error.orderNotFound');
    if (code === 'TOO_LONG') return t('support.form.error.tooLongShort');
    if (field === 'subject') return t('support.form.error.subjectRequired');
    if (field === 'message')
      return t('support.form.error.messageTooShort', { min: String(limits.messageMin) });
    return t('support.form.error.categoryRequired');
  }

  const summary = isSubmitted
    ? FIELDS.flatMap((field) => {
        const message = errors[field]?.message;
        return message === undefined ? [] : [{ field, message }];
      })
    : [];

  const raisingFor = requester.companyName ?? null;

  return (
    <form
      noValidate
      name="raise-ticket"
      aria-describedby={statusId}
      onSubmit={(event) => {
        event.preventDefault();
        if (inFlight.current) return;
        inFlight.current = true;
        void handleSubmit((values) => send.mutateAsync(values).catch(() => undefined))(
          event,
        ).finally(() => {
          inFlight.current = false;
        });
      }}
      className="flex flex-col gap-4"
    >
      {summary.length > 0 && (
        <ErrorSummary title={t('support.form.error.summaryTitle')} errors={summary} />
      )}

      {/* Whose name the ticket goes in, read from the account - not a field. */}
      <p className="flex items-start gap-2 rounded-md bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
        <UserIcon className="mt-px h-4 w-4 shrink-0 text-ink-subtle" />
        <span>
          {raisingFor === null
            ? t('support.form.raisingAs', {
                name: requester.name || requester.email,
                email: requester.email,
              })
            : t('support.form.raisingAsFor', {
                name: requester.name || requester.email,
                email: requester.email,
                company: raisingFor,
              })}
        </span>
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('support.form.category')} required error={errors.category?.message}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors.category !== undefined}
              required
              {...register('category')}
            >
              <option value="" disabled>
                {t('support.form.categoryPlaceholder')}
              </option>
              {SUPPORT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`support.category.${category}` as TranslationKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {requester.canReferenceOrder && (
          <Field
            label={t('support.form.orderNumber')}
            hint={t('support.form.orderNumberHint')}
            error={errors.orderNumber?.message}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={errors.orderNumber !== undefined}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                enterKeyHint="next"
                {...register('orderNumber')}
              />
            )}
          </Field>
        )}
      </div>

      <Field label={t('support.form.subject')} required error={errors.subject?.message}>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            invalid={errors.subject !== undefined}
            autoComplete="off"
            enterKeyHint="next"
            maxLength={limits.subjectMax}
            required
            {...register('subject')}
          />
        )}
      </Field>

      <Field
        label={t('support.form.message')}
        required
        hint={t('support.form.messageHint', {
          used: String(messageLength),
          max: String(limits.messageMax),
        })}
        error={errors.message?.message}
      >
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            invalid={errors.message !== undefined}
            rows={6}
            autoComplete="off"
            className="resize-y"
            required
            {...register('message')}
          />
        )}
      </Field>

      {fileRules.available ? (
        <SupportFilePicker
          files={files}
          onChange={setFiles}
          rules={fileRules}
          disabled={send.isPending}
        />
      ) : (
        <p className="text-xs text-ink-muted">{t('support.files.unavailable')}</p>
      )}

      {problem !== null && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-ink"
        >
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <span>{problem}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          isLoading={send.isPending}
          className="min-w-[12rem]"
        >
          {!send.isPending && <SendIcon className="h-4 w-4" />}
          {send.isPending
            ? uploading !== null
              ? t('support.files.uploading', {
                  index: String(uploading.index),
                  total: String(uploading.total),
                })
              : t('support.form.sending')
            : t('support.form.submit')}
        </Button>
        <p className="text-xs text-ink-muted">{t('support.form.privacy')}</p>
      </div>

      {/* Polite, so it does not cut across the field someone is reading. */}
      <p id={statusId} aria-live="polite" className="sr-only">
        {send.isPending
          ? uploading !== null
            ? t('support.files.uploading', {
                index: String(uploading.index),
                total: String(uploading.total),
              })
            : t('support.form.sending')
          : ''}
      </p>
    </form>
  );
}
