/**
 * Storefront content: home banners and category content blocks (checklist
 * Master row 72).
 *
 * Each block is targeted at a country and/or a language (blank = everyone),
 * scheduled (start / end, either open) and shown only once published. A
 * block can promote an existing coupon by its code; the storefront shows that
 * code only while the coupon is active and publicly listed. Coupons are made
 * on the Coupons page, never here.
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
import { useI18n } from '@/i18n/i18n-context';

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
  sortOrder: number;
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
    isPublished: block?.isPublished ?? false,
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
function liveState(block: ContentBlock, now: number): 'draft' | 'scheduled' | 'ended' | 'live' {
  if (!block.isPublished) return 'draft';
  if (block.startsAt !== null && new Date(block.startsAt).getTime() > now) return 'scheduled';
  if (block.endsAt !== null && new Date(block.endsAt).getTime() <= now) return 'ended';
  return 'live';
}

const LIVE_TONE = { draft: 'neutral', scheduled: 'accent', ended: 'neutral', live: 'success' } as const;

export function ContentBlocksPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const canWrite = can(Permission.SETTINGS_WRITE);

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
        ? api.post('/admin/content-blocks', body)
        : api.put(`/admin/content-blocks/${editing.id}`, body),
    onSuccess: async () => {
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
                <CheckboxField label={t('contentBlocks.published')} checked={draft.isPublished}
                  onChange={(event) => { set({ isPublished: event.target.checked }); }} />
              </div>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" disabled={save.isPending}>{t('contentBlocks.save')}</Button>
                <Button type="button" variant="secondary" onClick={() => { setEditing(null); }}>{t('contentBlocks.cancel')}</Button>
              </div>
            </form>
          </Card>
        )}

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
                      <div className="flex gap-2">
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
    </>
  );
}
