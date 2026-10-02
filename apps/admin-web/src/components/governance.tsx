/**
 * Admin governance pieces shared by the record pages (JOURNEY-061).
 *
 *   - `RecordHistoryCard` - the audit trail of one record, newest first.
 *   - `PendingActionsCard` - critical actions on one record waiting for a
 *     second member of staff, with Approve and Reject for whoever may decide.
 *   - `ReasonDialog` - a confirmation that will not go without a reason.
 *   - `MessageAccountDialog` - write to a customer or a seller.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { ApiError, api } from '@/lib/api';

import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { PENDING_ACTIONS_KEY, type PendingAction } from '@/lib/governance';
import { newIdempotencyKey } from '@/lib/forms';
import { Permission } from '@/lib/permissions';

export function RecordHistoryCard({
  resourceType,
  resourceId,
}: {
  resourceType: string;
  resourceId: string;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const { can } = useSession();
  const allowed = can(Permission.AUDIT_READ);

  const query = useQuery({
    queryKey: ['record-history', resourceType, resourceId],
    queryFn: () =>
      api.get<{ entries: { id: string; action: string; actorEmail: string | null; reason: string | null; createdAt: string }[] }>(
        `/admin/audit-logs?resourceType=${encodeURIComponent(resourceType)}&resourceId=${encodeURIComponent(resourceId)}&limit=25`,
      ),
    enabled: allowed,
  });

  if (!allowed) return null;

  return (
    <Card title={t('governance.history.title')} description={t('governance.history.description')}>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : query.data.entries.length === 0 ? (
        <EmptyState title={t('governance.history.empty')} />
      ) : (
        <ol className="divide-y divide-border-subtle" aria-label={t('governance.history.title')}>
          {query.data.entries.map((entry) => (
            <li key={entry.id} className="px-5 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xxs font-medium text-ink">{entry.action}</span>
                <span className="text-xxs text-ink-muted">{formatDateTime(entry.createdAt)}</span>
              </div>
              <p className="mt-0.5 text-xxs text-ink-muted">
                {entry.actorEmail ?? t('governance.history.system')}
                {entry.reason !== null && ` - ${entry.reason}`}
              </p>
            </li>
          ))}
        </ol>
      )}
      <p className="px-5 pb-3 text-xxs text-ink-muted">
        <Link className="underline" to={`/audit?resourceType=${encodeURIComponent(resourceType)}`}>
          {t('governance.history.openAudit')}
        </Link>
      </p>
    </Card>
  );
}

export function PendingActionsCard({
  resourceType,
  resourceId,
}: {
  resourceType?: string;
  resourceId?: string;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const { user, can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const mayDecide = can(Permission.CUSTOMER_STATUS_WRITE) || can(Permission.BUYER_COMPANY_SUSPEND);

  const params = new URLSearchParams({ status: 'PENDING' });
  if (resourceType !== undefined) params.set('resourceType', resourceType);
  if (resourceId !== undefined) params.set('resourceId', resourceId);

  const query = useQuery({
    queryKey: [...PENDING_ACTIONS_KEY, resourceType ?? '', resourceId ?? ''],
    queryFn: () => api.get<{ actions: PendingAction[] }>(`/admin/pending-actions?${params.toString()}`),
    enabled: mayDecide,
  });

  const decide = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'approve' | 'reject' }) =>
      api.post<{ action: PendingAction }>(`/admin/pending-actions/${id}/${verb}`, {}),
    onSuccess: async (_result, variables) => {
      toast.success(variables.verb === 'approve' ? t('governance.pending.approved') : t('governance.pending.rejected'));
      await queryClient.invalidateQueries();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  if (!mayDecide) return null;
  // On a record page an empty list says nothing worth a card.
  if (resourceId !== undefined && (query.data?.actions.length ?? 0) === 0) return null;

  return (
    <div id="approvals">
      <Card title={t('governance.pending.title')} description={t('governance.pending.description')}>
        {query.isPending ? (
          <LoadingState />
        ) : query.isError ? (
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : query.data.actions.length === 0 ? (
          <EmptyState title={t('governance.pending.empty')} />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {query.data.actions.map((action) => {
              const own = action.requestedById === user?.id;
              return (
                <li key={action.id} className="space-y-2 px-5 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="warning">{t(`governance.kind.${action.kind}` as TranslationKey)}</Badge>
                    <span className="font-medium text-ink">{action.resourceLabel}</span>
                  </div>
                  <p className="text-ink">{action.reason}</p>
                  <p className="text-xxs text-ink-muted">
                    {t('governance.pending.requestedBy', {
                      email: action.requestedByEmail,
                      when: formatDateTime(action.requestedAt),
                    })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={own}
                      title={own ? t('governance.pending.notYourOwn') : undefined}
                      isLoading={decide.isPending && decide.variables.id === action.id && decide.variables.verb === 'approve'}
                      onClick={() => {
                        decide.mutate({ id: action.id, verb: 'approve' });
                      }}
                    >
                      {t('governance.pending.approve')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      isLoading={decide.isPending && decide.variables.id === action.id && decide.variables.verb === 'reject'}
                      onClick={() => {
                        decide.mutate({ id: action.id, verb: 'reject' });
                      }}
                    >
                      {own ? t('governance.pending.withdraw') : t('governance.pending.reject')}
                    </Button>
                  </div>
                  {own && <p className="text-xxs text-ink-muted">{t('governance.pending.notYourOwn')}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function ReasonDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  isWorking,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  title: string;
  body: string;
  confirmLabel: string;
  isWorking: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const tooShort = reason.trim().length < 3;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      description={body}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={tooShort}
            isLoading={isWorking}
            onClick={() => {
              onConfirm(reason.trim());
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Field label={t('governance.reason.label')} hint={t('governance.reason.hint')} required>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            rows={3}
            maxLength={512}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        )}
      </Field>
    </Modal>
  );
}

export function MessageAccountDialog({
  isOpen,
  onClose,
  target,
  id,
  name,
}: {
  isOpen: boolean;
  onClose: () => void;
  target: 'CUSTOMER' | 'SELLER';
  id: string;
  name: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [key] = useState(newIdempotencyKey);

  const send = useMutation({
    mutationFn: () =>
      api.post<{ emailQueued: boolean; noticePosted: boolean }>(
        '/admin/account-messages',
        { target, id, subject: subject.trim(), message: message.trim() },
        { idempotencyKey: key },
      ),
    onSuccess: async () => {
      toast.success(t('governance.message.sent', { name }));
      setSubject('');
      setMessage('');
      onClose();
      await queryClient.invalidateQueries({ queryKey: ['record-history'] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? errorMessage(t, error) : t('common.somethingWentWrong'));
    },
  });

  const ready = subject.trim().length >= 3 && message.trim().length >= 3;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('governance.message.title', { name })}
      description={target === 'SELLER' ? t('governance.message.sellerHint') : t('governance.message.customerHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            isLoading={send.isPending}
            onClick={() => {
              send.mutate();
            }}
          >
            {t('governance.message.send')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('governance.message.subject')} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              maxLength={160}
              value={subject}
              onChange={(event) => {
                setSubject(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t('governance.message.body')} required>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={6}
              maxLength={4000}
              value={message}
              onChange={(event) => {
                setMessage(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}
