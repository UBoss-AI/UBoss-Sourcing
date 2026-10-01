/**
 * Master data (checklist Master row 75): units of measure, Incoterms and
 * inspection defect codes. Categories and currencies have their own screens.
 *
 * One list at a time. An entry is never deleted - it is switched off - so a
 * code already printed on a document keeps meaning what it meant. Reading
 * needs settings.read; adding, editing and switching off need settings.write.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

export type MasterDataKind = 'UOM' | 'INCOTERM' | 'DEFECT_CODE';
type Severity = 'CRITICAL' | 'MAJOR' | 'MINOR';

export interface MasterDataEntry {
  id: string;
  kind: MasterDataKind;
  code: string;
  name: string;
  description: string | null;
  defaultSeverity: Severity | null;
  sortOrder: number;
  isActive: boolean;
}

const KINDS: readonly MasterDataKind[] = ['UOM', 'INCOTERM', 'DEFECT_CODE'];
const SEVERITIES: readonly Severity[] = ['CRITICAL', 'MAJOR', 'MINOR'];

interface Draft {
  id: string | null;
  code: string;
  name: string;
  description: string;
  defaultSeverity: Severity | '';
  sortOrder: string;
}

const EMPTY: Draft = { id: null, code: '', name: '', description: '', defaultSeverity: '', sortOrder: '0' };

export function MasterDataPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const canWrite = can(Permission.SETTINGS_WRITE);

  const [kind, setKind] = useState<MasterDataKind>('UOM');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['master-data', kind],
    queryFn: () => api.get<{ entries: MasterDataEntry[] }>(`/admin/master-data/${kind}`),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['master-data', kind] });
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        code: draft.code.trim(),
        name: draft.name.trim(),
        description: draft.description.trim() === '' ? null : draft.description.trim(),
        sortOrder: Number.parseInt(draft.sortOrder, 10) || 0,
        ...(kind === 'DEFECT_CODE'
          ? { defaultSeverity: draft.defaultSeverity === '' ? null : draft.defaultSeverity }
          : {}),
      };
      return draft.id === null
        ? api.post(`/admin/master-data/${kind}`, body)
        : api.patch(`/admin/master-data/${kind}/${draft.id}`, body);
    },
    onSuccess: async () => {
      toast.success(t('masterData.saved'));
      setDraft(EMPTY);
      setError(null);
      await refresh();
    },
    onError: (failure) => {
      setError(errorMessage(t, failure, t('masterData.saveFailed')));
    },
  });

  const toggle = useMutation({
    mutationFn: (entry: MasterDataEntry) =>
      api.patch(`/admin/master-data/${kind}/${entry.id}`, { isActive: !entry.isActive }),
    onSuccess: refresh,
    onError: (failure) => {
      setError(errorMessage(t, failure, t('masterData.saveFailed')));
    },
  });

  const set = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const entries = query.data?.entries ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title={t('masterData.title')} description={t('masterData.description')} />

      <Card bodyClassName="space-y-4 px-5 py-4">
        <Field label={t('masterData.list')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as MasterDataKind);
                setDraft(EMPTY);
                setError(null);
              }}
            >
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {t(`masterData.kind.${value}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {!canWrite && <Callout tone="neutral">{t('settings.youCanReadTheseSettings')}</Callout>}
        {error !== null && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}

        {query.isPending && <LoadingState label={t('masterData.loading')} />}
        {query.isError && (
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        )}
        {query.isSuccess && entries.length === 0 && <EmptyState title={t('masterData.empty')} />}

        {entries.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-surface-sunken text-xs text-ink-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{t('masterData.code')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('masterData.name')}</th>
                  {kind === 'DEFECT_CODE' && (
                    <th className="px-3 py-2 text-left font-medium">{t('masterData.severity')}</th>
                  )}
                  <th className="px-3 py-2 text-left font-medium">{t('masterData.status')}</th>
                  {canWrite && <th className="px-3 py-2 text-right font-medium">{t('masterData.actions')}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-3 py-2 font-mono text-xs text-ink">{entry.code}</td>
                    <td className="px-3 py-2 text-ink">
                      {entry.name}
                      {entry.description !== null && (
                        <span className="block text-xs text-ink-muted">{entry.description}</span>
                      )}
                    </td>
                    {kind === 'DEFECT_CODE' && (
                      <td className="px-3 py-2">
                        {entry.defaultSeverity === null ? '—' : t(`masterData.severityValue.${entry.defaultSeverity}`)}
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <Badge tone={entry.isActive ? 'success' : 'neutral'}>
                        {entry.isActive ? t('masterData.active') : t('masterData.inactive')}
                      </Badge>
                    </td>
                    {canWrite && (
                      <td className="space-x-2 whitespace-nowrap px-3 py-2 text-right">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setDraft({
                              id: entry.id,
                              code: entry.code,
                              name: entry.name,
                              description: entry.description ?? '',
                              defaultSeverity: entry.defaultSeverity ?? '',
                              sortOrder: String(entry.sortOrder),
                            });
                          }}
                        >
                          {t('masterData.edit')}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={toggle.isPending}
                          onClick={() => {
                            toggle.mutate(entry);
                          }}
                        >
                          {entry.isActive ? t('masterData.deactivate') : t('masterData.activate')}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {canWrite && (
        <Card title={draft.id === null ? t('masterData.addTitle') : t('masterData.editTitle')} bodyClassName="px-5 py-4">
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.code.trim() === '' || draft.name.trim() === '') {
                setError(t('masterData.codeAndNameRequired'));
                return;
              }
              save.mutate();
            }}
          >
            <Field label={t('masterData.code')}>
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} value={draft.code} maxLength={16}
                  onChange={(event) => { set({ code: event.target.value }); }} />
              )}
            </Field>
            <Field label={t('masterData.name')}>
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} value={draft.name} maxLength={120}
                  onChange={(event) => { set({ name: event.target.value }); }} />
              )}
            </Field>
            <Field label={t('masterData.descriptionField')}>
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} value={draft.description} maxLength={500}
                  onChange={(event) => { set({ description: event.target.value }); }} />
              )}
            </Field>
            <Field label={t('masterData.sortOrder')}>
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} type="number" min={0} value={draft.sortOrder}
                  onChange={(event) => { set({ sortOrder: event.target.value }); }} />
              )}
            </Field>
            {kind === 'DEFECT_CODE' && (
              <Field label={t('masterData.severity')}>
                {({ inputId, describedBy }) => (
                  <Select id={inputId} aria-describedby={describedBy} value={draft.defaultSeverity}
                    onChange={(event) => { set({ defaultSeverity: event.target.value as Severity | '' }); }}>
                    <option value="">—</option>
                    {SEVERITIES.map((value) => (
                      <option key={value} value={value}>
                        {t(`masterData.severityValue.${value}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <div className="flex items-end gap-2 sm:col-span-2">
              <Button type="submit" variant="primary" disabled={save.isPending}>
                {draft.id === null ? t('masterData.add') : t('masterData.save')}
              </Button>
              {draft.id !== null && (
                <Button variant="secondary" onClick={() => { setDraft(EMPTY); }}>
                  {t('masterData.cancel')}
                </Button>
              )}
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
