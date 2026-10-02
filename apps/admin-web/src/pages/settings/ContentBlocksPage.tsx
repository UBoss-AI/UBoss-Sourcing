/**
 * Storefront content: home banners and category content blocks (checklist
 * Master row 72).
 *
 * Each block is targeted at a country and/or a language (blank = everyone),
 * scheduled (start / end, either open) and shown only once published. A
 * block can promote an existing coupon by its code; the storefront shows that
 * code only while the coupon is active and publicly listed. Coupons are made
 * on the Coupons page, never here.
 *
 * JOURNEY-067: a block is published only when a second member of staff
 * approves it, and any edit sends it back to draft. Saving returns conflict
 * warnings (a coupon that is not usable for the whole schedule, a banner
 * overlapping another for the same audience); approval refuses the serious
 * ones. Every save is a version that can be restored, and Preview shows what
 * the storefront would show for a country, a language and a moment.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, CheckboxField, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { CategoryNode } from '@/lib/types';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { Modal } from '@/components/Modal';

type Placement = 'HOME_BANNER' | 'CATEGORY_BLOCK';

export interface ContentBlock {
  id: string;
  placement: Placement;
  category: { id: string; slug: string; name: string } | null;
  title: string;
  body: string | null;
  imageUrl: string | null;
  linkUrl: string | null;
  coupon: { code: string; status: string; isPubliclyListed: boolean } | null;
  countryCode: string;
  languageCode: string;
  startsAt: string | null;
  endsAt: string | null;
  isPublished: boolean;
  /** DRAFT, PENDING_APPROVAL or PUBLISHED (JOURNEY-067). */
  status?: 'DRAFT' | 'PENDING_APPROVAL' | 'PUBLISHED';
  revision?: number;
  submittedById?: string | null;
  sortOrder: number;
}

interface ContentConflict {
  code: string;
  blocking: boolean;
  meta?: Record<string, string>;
}

interface Draft {
  placement: Placement;
  categoryId: string;
  title: string;
  body: string;
  imageUrl: string;
  linkUrl: string;
  couponCode: string;
  countryCode: string;
  languageCode: string;
  startsAt: string;
  endsAt: string;
  isPublished: boolean;
  sortOrder: string;
}

/** An ISO instant as the value a datetime-local input takes, in local time. */
function localInput(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function draftFrom(block: ContentBlock | null): Draft {
  return {
    placement: block?.placement ?? 'HOME_BANNER',
    categoryId: block?.category?.id ?? '',
    title: block?.title ?? '',
    body: block?.body ?? '',
    imageUrl: block?.imageUrl ?? '',
    linkUrl: block?.linkUrl ?? '',
    couponCode: block?.coupon?.code ?? '',
    countryCode: block?.countryCode ?? '',
    languageCode: block?.languageCode ?? '',
    startsAt: localInput(block?.startsAt ?? null),
    endsAt: localInput(block?.endsAt ?? null),
    // Ticking it sends the block for approval; an edit always starts as a draft.
    isPublished: false,
    sortOrder: String(block?.sortOrder ?? 0),
  };
}

function flatten(nodes: CategoryNode[], depth = 0): { id: string; label: string }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${' '.repeat(depth)}${node.name}` },
    ...flatten(node.children, depth + 1),
  ]);
}

/** What the list says about when a block shows. */
function liveState(block: ContentBlock, now: number): 'draft' | 'pending' | 'scheduled' | 'ended' | 'live' {
  if (block.status === 'PENDING_APPROVAL') return 'pending';
  if (!block.isPublished) return 'draft';
  if (block.startsAt !== null && new Date(block.startsAt).getTime() > now) return 'scheduled';
  if (block.endsAt !== null && new Date(block.endsAt).getTime() <= now) return 'ended';
  return 'live';
}

const LIVE_TONE = { draft: 'neutral', pending: 'warning', scheduled: 'accent', ended: 'neutral', live: 'success' } as const;

export function ContentBlocksPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can, user } = useSession();
  const canWrite = can(Permission.SETTINGS_WRITE);

  const [warnings, setWarnings] = useState<ContentConflict[]>([]);
  const [historyFor, setHistoryFor] = useState<ContentBlock | null>(null);
  const [editing, setEditing] = useState<ContentBlock | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(draftFrom(null));
  const [error, setError] = useState<string | null>(null);

  const blocks = useQuery({
    queryKey: ['content-blocks'],
    queryFn: () => api.get<{ blocks: ContentBlock[] }>('/admin/content-blocks'),
  });
  const categories = useQuery({
    queryKey: ['admin-categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/admin/categories'),
    enabled: editing !== null,
  });
  const categoryOptions = useMemo(() => flatten(categories.data?.categories ?? []), [categories.data]);

  const set = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const open = (block: ContentBlock | 'new'): void => {
    setEditing(block);
    setDraft(draftFrom(block === 'new' ? null : block));
    setError(null);
  };

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing === 'new' || editing === null
        ? api.post<{ warnings?: ContentConflict[] }>('/admin/content-blocks', body)
        : api.put<{ warnings?: ContentConflict[] }>(`/admin/content-blocks/${editing.id}`, body),
    onSuccess: async (result) => {
      setWarnings(result.warnings ?? []);
      toast.success(t('contentBlocks.saved'));
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: ['content-blocks'] });
    },
    onError: (failure) => {
      setError(errorMessage(t, failure, t('contentBlocks.saveFailed')));
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/content-blocks/${id}`),
    onSuccess: async () => {
      toast.success(t('contentBlocks.deleted'));
      await queryClient.invalidateQueries({ queryKey: ['content-blocks'] });
    },
    onError: (failure) => {
      toast.error(errorMessage(t, failure, t('contentBlocks.saveFailed')));
    },
  });

  const act = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'submit' | 'approve' | 'return' }) =>
      api.post(`/admin/content-blocks/${id}/${verb}`, {}),
    onSuccess: async (_result, { verb }) => {
      toast.success(t(`contentBlocks.done.${verb}` as TranslationKey));
      await queryClient.invalidateQueries({ queryKey: ['content-blocks'] });
    },
    onError: (failure) => {
      toast.error(errorMessage(t, failure, t('contentBlocks.saveFailed')));
    },
  });

  const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());
  const instant = (value: string): string | null => (value === '' ? null : new Date(value).toISOString());

  const submit = (): void => {
    setError(null);
    save.mutate({
      placement: draft.placement,
      categoryId: draft.placement === 'CATEGORY_BLOCK' ? orNull(draft.categoryId) : null,
      title: draft.title.trim(),
      body: orNull(draft.body),
      imageUrl: orNull(draft.imageUrl),
      linkUrl: orNull(draft.linkUrl),
      couponCode: orNull(draft.couponCode),
      countryCode: draft.countryCode.trim(),
      languageCode: draft.languageCode.trim().toLowerCase(),
      startsAt: instant(draft.startsAt),
      endsAt: instant(draft.endsAt),
      isPublished: draft.isPublished,
      sortOrder: Number(draft.sortOrder) || 0,
    });
  };

  const now = Date.now();

  return (
    <>
      <PageHeader
        title={t('contentBlocks.title')}
        description={t('contentBlocks.description')}
        actions={canWrite ? <Button onClick={() => { open('new'); }}>{t('contentBlocks.add')}</Button> : undefined}
      />
      <div className="space-y-5">
        {editing !== null && (
          <Card title={editing === 'new' ? t('contentBlocks.add') : t('contentBlocks.edit')} bodyClassName="px-5 py-4">
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              {error !== null && (
                <div className="sm:col-span-2">
                  <Callout tone="danger" role="alert">{error}</Callout>
                </div>
              )}
              <Field label={t('contentBlocks.placement')}>
                {({ inputId }) => (
                  <Select id={inputId} value={draft.placement}
                    onChange={(event) => { set({ placement: event.target.value as Placement }); }}>
                    <option value="HOME_BANNER">{t('contentBlocks.placementHome')}</option>
                    <option value="CATEGORY_BLOCK">{t('contentBlocks.placementCategory')}</option>
                  </Select>
                )}
              </Field>
              {draft.placement === 'CATEGORY_BLOCK' ? (
                <Field label={t('contentBlocks.category')} required>
                  {({ inputId }) => (
                    <Select id={inputId} value={draft.categoryId} required
                      onChange={(event) => { set({ categoryId: event.target.value }); }}>
                      <option value="">{t('contentBlocks.chooseCategory')}</option>
                      {categoryOptions.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : (
                <div />
              )}
              <div className="sm:col-span-2">
                <Field label={t('contentBlocks.blockTitle')} required>
                  {({ inputId }) => (
                    <Input id={inputId} value={draft.title} maxLength={160} required
                      onChange={(event) => { set({ title: event.target.value }); }} />
                  )}
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label={t('contentBlocks.body')}>
                  {({ inputId }) => (
                    <Textarea id={inputId} rows={3} maxLength={4000} value={draft.body}
                      onChange={(event) => { set({ body: event.target.value }); }} />
                  )}
                </Field>
              </div>
              <Field label={t('contentBlocks.imageUrl')} hint={t('contentBlocks.urlHint')}>
                {({ inputId, describedBy }) => (
                  <Input id={inputId} aria-describedby={describedBy} value={draft.imageUrl} maxLength={1024}
                    onChange={(event) => { set({ imageUrl: event.target.value }); }} />
                )}
              </Field>
              <Field label={t('contentBlocks.linkUrl')} hint={t('contentBlocks.urlHint')}>
                {({ inputId, describedBy }) => (
                  <Input id={inputId} aria-describedby={describedBy} value={draft.linkUrl} maxLength={1024}
                    onChange={(event) => { set({ linkUrl: event.target.value }); }} />
                )}
              </Field>
              <Field label={t('contentBlocks.coupon')} hint={t('contentBlocks.couponHint')}>
                {({ inputId, describedBy }) => (
                  <Input id={inputId} aria-describedby={describedBy} value={draft.couponCode} maxLength={32}
                    onChange={(event) => { set({ couponCode: event.target.value.toUpperCase() }); }} />
                )}
              </Field>
              <Field label={t('contentBlocks.sortOrder')}>
                {({ inputId }) => (
                  <Input id={inputId} type="number" value={draft.sortOrder}
                    onChange={(event) => { set({ sortOrder: event.target.value }); }} />
                )}
              </Field>
              <Field label={t('contentBlocks.country')} hint={t('contentBlocks.everyoneHint')}>
                {({ inputId, describedBy }) => (
                  <Input id={inputId} aria-describedby={describedBy} value={draft.countryCode} maxLength={2}
                    onChange={(event) => { set({ countryCode: event.target.value.toUpperCase() }); }} />
                )}
              </Field>
              <Field label={t('contentBlocks.language')} hint={t('contentBlocks.everyoneHint')}>
                {({ inputId, describedBy }) => (
                  <Input id={inputId} aria-describedby={describedBy} value={draft.languageCode} maxLength={8}
                    onChange={(event) => { set({ languageCode: event.target.value }); }} />
                )}
              </Field>
              <Field label={t('contentBlocks.startsAt')}>
                {({ inputId }) => (
                  <Input id={inputId} type="datetime-local" value={draft.startsAt}
                    onChange={(event) => { set({ startsAt: event.target.value }); }} />
                )}
              </Field>
              <Field label={t('contentBlocks.endsAt')}>
                {({ inputId }) => (
                  <Input id={inputId} type="datetime-local" value={draft.endsAt}
                    onChange={(event) => { set({ endsAt: event.target.value }); }} />
                )}
              </Field>
              <div className="sm:col-span-2">
                <CheckboxField label={t('contentBlocks.sendForApproval')} checked={draft.isPublished}
                  onChange={(event) => { set({ isPublished: event.target.checked }); }} />
              </div>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" disabled={save.isPending}>{t('contentBlocks.save')}</Button>
                <Button type="button" variant="secondary" onClick={() => { setEditing(null); }}>{t('contentBlocks.cancel')}</Button>
              </div>
            </form>
          </Card>
        )}

        {warnings.length > 0 && (
          <Callout tone="warning" title={t('contentBlocks.conflictsTitle')} role="status">
            <ul className="list-disc pl-5 text-sm">
              {warnings.map((warning, index) => (
                <li key={`${warning.code}-${String(index)}`}>
                  {t(`contentBlocks.conflict.${warning.code}` as TranslationKey, {
                    coupon: warning.meta?.coupon ?? '',
                    title: warning.meta?.title ?? '',
                    currency: warning.meta?.currency ?? '',
                  })}
                  {warning.blocking && ` ${t('contentBlocks.conflictBlocking')}`}
                </li>
              ))}
            </ul>
          </Callout>
        )}

        <ContentPreview />

        <Card
          title={t('contentBlocks.listTitle')}
          description={can(Permission.COUPON_READ) ? undefined : t('contentBlocks.couponsElsewhere')}
          bodyClassName="px-5 py-4"
        >
          {can(Permission.COUPON_READ) && (
            <p className="mb-3 text-sm">
              <Link className="text-accent underline" to="/coupons">{t('contentBlocks.manageCoupons')}</Link>
            </p>
          )}
          {blocks.isPending && <LoadingState label={t('contentBlocks.loading')} />}
          {blocks.isError && <ErrorState error={blocks.error} onRetry={() => { void blocks.refetch(); }} />}
          {blocks.isSuccess && blocks.data.blocks.length === 0 && <EmptyState title={t('contentBlocks.empty')} />}
          {blocks.isSuccess && blocks.data.blocks.length > 0 && (
            <ul className="divide-y divide-line" aria-label={t('contentBlocks.listTitle')}>
              {blocks.data.blocks.map((block) => {
                const state = liveState(block, now);
                return (
                  <li key={block.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="min-w-0 space-y-1 text-sm">
                      <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                        <span>{block.title}</span>
                        <Badge tone={LIVE_TONE[state]}>{t(`contentBlocks.state.${state}`)}</Badge>
                        <Badge tone="neutral">
                          {block.placement === 'HOME_BANNER'
                            ? t('contentBlocks.placementHome')
                            : `${t('contentBlocks.placementCategory')}: ${block.category?.name ?? ''}`}
                        </Badge>
                      </p>
                      <p className="text-xs text-ink-muted">
                        {t('contentBlocks.targeting', {
                          country: block.countryCode === '' ? t('contentBlocks.everyone') : block.countryCode,
                          language: block.languageCode === '' ? t('contentBlocks.everyone') : block.languageCode,
                        })}
                        {block.startsAt !== null && ` · ${t('contentBlocks.from', { date: formatDateTime(block.startsAt) })}`}
                        {block.endsAt !== null && ` · ${t('contentBlocks.until', { date: formatDateTime(block.endsAt) })}`}
                        {block.coupon !== null && ` · ${t('contentBlocks.promotes', { code: block.coupon.code })}`}
                      </p>
                    </div>
                    {canWrite && (
                      <div className="flex flex-wrap gap-2">
                        {block.status === 'DRAFT' && (
                          <Button size="sm" variant="primary" disabled={act.isPending}
                            onClick={() => { act.mutate({ id: block.id, verb: 'submit' }); }}>
                            {t('contentBlocks.submit')}
                          </Button>
                        )}
                        {block.status === 'PENDING_APPROVAL' && (
                          <Button size="sm" variant="primary" disabled={act.isPending || block.submittedById === user?.id}
                            title={block.submittedById === user?.id ? t('contentBlocks.notYourOwn') : undefined}
                            onClick={() => { act.mutate({ id: block.id, verb: 'approve' }); }}>
                            {t('contentBlocks.approve')}
                          </Button>
                        )}
                        {(block.status === 'PENDING_APPROVAL' || block.status === 'PUBLISHED') && (
                          <Button size="sm" variant="ghost" disabled={act.isPending}
                            onClick={() => { act.mutate({ id: block.id, verb: 'return' }); }}>
                            {t('contentBlocks.return')}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => { setHistoryFor(block); }}>{t('contentBlocks.versions')}</Button>
                        <Button size="sm" variant="secondary" onClick={() => { open(block); }}>{t('contentBlocks.edit')}</Button>
                        <Button size="sm" variant="danger" disabled={remove.isPending}
                          onClick={() => {
                            if (window.confirm(t('contentBlocks.confirmDelete'))) remove.mutate(block.id);
                          }}>
                          {t('contentBlocks.delete')}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {historyFor !== null && (
        <VersionsDialog
          block={historyFor}
          canWrite={canWrite}
          onClose={() => {
            setHistoryFor(null);
          }}
        />
      )}
    </>
  );
}

interface BlockVersion {
  revision: number;
  snapshot: { title?: string; countryCode?: string; languageCode?: string; startsAt?: string | null; endsAt?: string | null; couponCode?: string | null };
  savedByEmail: string | null;
  savedAt: string;
}

/** Every saved version of a block; restoring one writes it back as a new draft (JOURNEY-067). */
function VersionsDialog({ block, canWrite, onClose }: { block: ContentBlock; canWrite: boolean; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const versions = useQuery({
    queryKey: ['content-block-versions', block.id],
    queryFn: () => api.get<{ versions: BlockVersion[] }>(`/admin/content-blocks/${block.id}/versions`),
  });
  const restore = useMutation({
    mutationFn: (revision: number) => api.post(`/admin/content-blocks/${block.id}/versions/${String(revision)}/restore`, {}),
    onSuccess: async () => {
      toast.success(t('contentBlocks.restored'));
      await queryClient.invalidateQueries({ queryKey: ['content-blocks'] });
      await queryClient.invalidateQueries({ queryKey: ['content-block-versions', block.id] });
      onClose();
    },
    onError: (failure) => {
      toast.error(errorMessage(t, failure, t('contentBlocks.saveFailed')));
    },
  });
  return (
    <Modal isOpen onClose={onClose} title={t('contentBlocks.versionsTitle', { title: block.title })} size="lg">
      {versions.isPending && <LoadingState />}
      {versions.isError && <ErrorState error={versions.error} onRetry={() => { void versions.refetch(); }} />}
      {versions.isSuccess && versions.data.versions.length === 0 && <EmptyState title={t('contentBlocks.noVersions')} />}
      {versions.isSuccess && versions.data.versions.length > 0 && (
        <ol className="divide-y divide-line">
          {versions.data.versions.map((version) => (
            <li key={version.revision} className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-ink">
                  {t('contentBlocks.revision', { revision: String(version.revision) })} · {version.snapshot.title}
                </p>
                <p className="text-xs text-ink-muted">
                  {formatDateTime(version.savedAt)} · {version.savedByEmail ?? '—'}
                </p>
              </div>
              {canWrite && version.revision !== block.revision && (
                <Button size="sm" variant="secondary" disabled={restore.isPending}
                  onClick={() => { restore.mutate(version.revision); }}>
                  {t('contentBlocks.restore')}
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

/** What the storefront would show for a country, a language and a moment, drafts included (JOURNEY-067). */
function ContentPreview(): React.JSX.Element {
  const { t } = useI18n();
  const [placement, setPlacement] = useState<Placement>('HOME_BANNER');
  const [country, setCountry] = useState('');
  const [language, setLanguage] = useState('');
  const [category, setCategory] = useState('');
  const [at, setAt] = useState('');
  const [includeUnpublished, setIncludeUnpublished] = useState(true);
  const [asked, setAsked] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ['content-block-preview', asked],
    queryFn: () => api.get<{ blocks: { id: string; title: string; status: string; couponCode: string | null }[] }>(`/admin/content-blocks/preview?${asked ?? ''}`),
    enabled: asked !== null,
  });

  const run = (): void => {
    const params = new URLSearchParams({ placement, includeUnpublished: String(includeUnpublished) });
    if (/^[A-Za-z]{2}$/.test(country.trim())) params.set('country', country.trim().toUpperCase());
    if (language.trim() !== '') params.set('language', language.trim().toLowerCase());
    if (placement === 'CATEGORY_BLOCK' && category.trim() !== '') params.set('category', category.trim());
    if (at !== '') params.set('at', new Date(at).toISOString());
    setAsked(params.toString());
  };

  return (
    <Card title={t('contentBlocks.previewTitle')} description={t('contentBlocks.previewDescription')} bodyClassName="space-y-3 px-5 py-4">
      <form
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        <Field label={t('contentBlocks.placement')}>
          {({ inputId }) => (
            <Select id={inputId} value={placement} onChange={(event) => { setPlacement(event.target.value as Placement); }}>
              <option value="HOME_BANNER">{t('contentBlocks.placementHome')}</option>
              <option value="CATEGORY_BLOCK">{t('contentBlocks.placementCategory')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('contentBlocks.country')}>
          {({ inputId }) => (
            <Input id={inputId} value={country} maxLength={2} onChange={(event) => { setCountry(event.target.value.toUpperCase()); }} />
          )}
        </Field>
        <Field label={t('contentBlocks.language')}>
          {({ inputId }) => (
            <Input id={inputId} value={language} maxLength={8} onChange={(event) => { setLanguage(event.target.value); }} />
          )}
        </Field>
        {placement === 'CATEGORY_BLOCK' && (
          <Field label={t('contentBlocks.previewCategory')}>
            {({ inputId }) => (
              <Input id={inputId} value={category} maxLength={255} onChange={(event) => { setCategory(event.target.value); }} />
            )}
          </Field>
        )}
        <Field label={t('contentBlocks.previewAt')}>
          {({ inputId }) => (
            <Input id={inputId} type="datetime-local" value={at} onChange={(event) => { setAt(event.target.value); }} />
          )}
        </Field>
        <div className="flex items-end gap-3 sm:col-span-3">
          <CheckboxField label={t('contentBlocks.previewIncludeDrafts')} checked={includeUnpublished}
            onChange={(event) => { setIncludeUnpublished(event.target.checked); }} />
          <Button type="submit" variant="secondary">{t('contentBlocks.previewRun')}</Button>
        </div>
      </form>
      {preview.isFetching && <LoadingState />}
      {preview.isError && <ErrorState error={preview.error} onRetry={() => { void preview.refetch(); }} />}
      {preview.isSuccess && preview.data.blocks.length === 0 && <EmptyState title={t('contentBlocks.previewEmpty')} />}
      {preview.isSuccess && preview.data.blocks.length > 0 && (
        <ol className="space-y-2" aria-label={t('contentBlocks.previewTitle')}>
          {preview.data.blocks.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle px-3 py-2 text-sm">
              <span className="font-medium text-ink">{row.title}</span>
              {row.status !== 'PUBLISHED' && <Badge tone="warning">{t(`contentBlocks.status.${row.status}` as TranslationKey)}</Badge>}
              {row.couponCode !== null && <Badge tone="accent">{row.couponCode}</Badge>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
