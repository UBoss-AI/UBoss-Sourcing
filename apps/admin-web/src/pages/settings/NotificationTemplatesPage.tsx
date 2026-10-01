/**
 * Notification templates (checklist Master row 76).
 *
 * Every event the system can send, with the wording it uses and the channels
 * it goes out on. An event nobody has customised shows its built-in wording;
 * saving it creates the customised copy. Channels:
 *
 * - Email: delivered by the mail driver.
 * - In-app: listed in the customer's notification centre. With email off and
 *   in-app on, the event is recorded for the notification centre only.
 * - WhatsApp: no provider ships with this product. Switching it on records
 *   each message as not sent, with the reason, so nothing pretends to deliver.
 * - SMS: stored, but no SMS driver exists yet either.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  CheckboxField,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Textarea,
} from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';
import {
  mergeEvents,
  type CatalogueRow,
  type NotificationEventView,
  type SettingRow,
} from '@/lib/notification-templates';

const CHANNELS = ['emailEnabled', 'inAppEnabled', 'whatsappEnabled', 'smsEnabled'] as const;

export function NotificationTemplatesPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const canWrite = can(Permission.SETTINGS_WRITE);

  const query = useQuery({
    queryKey: ['notification-templates'],
    queryFn: () =>
      api.get<{ notifications: SettingRow[]; catalogue: CatalogueRow[] }>('/admin/settings/notifications'),
  });

  const events = useMemo(
    () => mergeEvents(query.data?.notifications ?? [], query.data?.catalogue ?? []),
    [query.data],
  );

  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState<NotificationEventView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (row: NotificationEventView) =>
      api.put('/admin/settings/notifications', {
        eventKey: row.eventKey,
        name: row.name,
        subjectTemplate: row.subjectTemplate,
        bodyTemplate: row.bodyTemplate,
        emailEnabled: row.emailEnabled,
        smsEnabled: row.smsEnabled,
        whatsappEnabled: row.whatsappEnabled,
        inAppEnabled: row.inAppEnabled,
        whatsappTemplate: row.whatsappTemplate === null || row.whatsappTemplate.trim() === '' ? null : row.whatsappTemplate,
        isActive: row.isActive,
      }),
    onSuccess: async () => {
      toast.success(t('notificationTemplates.saved'));
      setDraft(null);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['notification-templates'] });
    },
    onError: (failure) => {
      setError(errorMessage(t, failure, t('notificationTemplates.saveFailed')));
    },
  });

  const set = (patch: Partial<NotificationEventView>): void => {
    setDraft((current) => (current === null ? current : { ...current, ...patch }));
  };

  const visible = events.filter((row) => row.eventKey.includes(filter.trim().toLowerCase()));

  return (
    <div className="space-y-6">
      <PageHeader title={t('notificationTemplates.title')} description={t('notificationTemplates.description')} />

      {!canWrite && <Callout tone="neutral">{t('settings.youCanReadTheseSettings')}</Callout>}
      {error !== null && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}

      {draft !== null && (
        <Card title={t('notificationTemplates.editTitle', { event: draft.eventKey })} bodyClassName="space-y-4 px-5 py-4">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.subjectTemplate.trim() === '' || draft.bodyTemplate.trim() === '') {
                setError(t('notificationTemplates.subjectAndBodyRequired'));
                return;
              }
              save.mutate(draft);
            }}
          >
            <Field label={t('notificationTemplates.name')}>
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} value={draft.name} maxLength={128} disabled={!canWrite}
                  onChange={(event) => { set({ name: event.target.value }); }} />
              )}
            </Field>
            <Field label={t('notificationTemplates.subject')} hint={t('notificationTemplates.placeholdersHint')}>
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} value={draft.subjectTemplate} maxLength={255} disabled={!canWrite}
                  onChange={(event) => { set({ subjectTemplate: event.target.value }); }} />
              )}
            </Field>
            <Field label={t('notificationTemplates.body')}>
              {({ inputId, describedBy }) => (
                <Textarea id={inputId} aria-describedby={describedBy} rows={8} maxLength={20000} value={draft.bodyTemplate} disabled={!canWrite}
                  onChange={(event) => { set({ bodyTemplate: event.target.value }); }} />
              )}
            </Field>

            <fieldset className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium text-ink">{t('notificationTemplates.channels')}</legend>
              {CHANNELS.map((channel) => (
                <CheckboxField
                  key={channel}
                  label={t(`notificationTemplates.channel.${channel}`)}
                  description={t(`notificationTemplates.channelHint.${channel}`)}
                  checked={draft[channel]}
                  disabled={!canWrite}
                  onChange={(event) => { set({ [channel]: event.target.checked }); }}
                />
              ))}
              <CheckboxField
                label={t('notificationTemplates.active')}
                description={t('notificationTemplates.activeHint')}
                checked={draft.isActive}
                disabled={!canWrite}
                onChange={(event) => { set({ isActive: event.target.checked }); }}
              />
            </fieldset>

            {draft.whatsappEnabled && (
              <>
                <Callout tone="warning">{t('notificationTemplates.whatsappNoProvider')}</Callout>
                <Field label={t('notificationTemplates.whatsappTemplate')} hint={t('notificationTemplates.whatsappTemplateHint')}>
                  {({ inputId, describedBy }) => (
                    <Textarea id={inputId} aria-describedby={describedBy} rows={4} maxLength={4096} value={draft.whatsappTemplate ?? ''} disabled={!canWrite}
                      onChange={(event) => { set({ whatsappTemplate: event.target.value }); }} />
                  )}
                </Field>
              </>
            )}

            <div className="flex gap-2">
              {canWrite && (
                <Button type="submit" variant="primary" disabled={save.isPending}>
                  {t('notificationTemplates.save')}
                </Button>
              )}
              <Button variant="secondary" onClick={() => { setDraft(null); setError(null); }}>
                {t('notificationTemplates.close')}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card bodyClassName="space-y-4 px-5 py-4">
        <Field label={t('notificationTemplates.filter')}>
          {({ inputId, describedBy }) => (
            <Input id={inputId} aria-describedby={describedBy} value={filter}
              onChange={(event) => { setFilter(event.target.value); }} />
          )}
        </Field>

        {query.isPending && <LoadingState label={t('notificationTemplates.loading')} />}
        {query.isError && (
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        )}

        {visible.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-surface-sunken text-xs text-ink-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{t('notificationTemplates.event')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('notificationTemplates.subject')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('notificationTemplates.channels')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('notificationTemplates.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {visible.map((row) => (
                  <tr key={row.eventKey}>
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs text-ink">{row.eventKey}</span>
                      <span className="mt-1 flex gap-1">
                        {row.customised ? (
                          <Badge tone="brand">{t('notificationTemplates.customised')}</Badge>
                        ) : (
                          <Badge>{t('notificationTemplates.builtIn')}</Badge>
                        )}
                        {!row.isActive && <Badge tone="warning">{t('notificationTemplates.off')}</Badge>}
                      </span>
                    </td>
                    <td className="max-w-xs truncate px-3 py-2 text-ink">{row.subjectTemplate}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {CHANNELS.filter((channel) => row[channel]).map((channel) => (
                          <Badge key={channel} tone="neutral">
                            {t(`notificationTemplates.channel.${channel}`)}
                          </Badge>
                        ))}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setDraft(row);
                          setError(null);
                        }}
                      >
                        {canWrite ? t('notificationTemplates.edit') : t('notificationTemplates.view')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
