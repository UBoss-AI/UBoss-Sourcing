/**
 * The seller's description and specifications for one listing.
 *
 * Repeatable controls - add, move up, move down, remove - for description
 * sections, specification groups and their rows, and per-option values; a
 * preview drawn by the same component the product page uses, so what the
 * seller previews is what a buyer reads; and one Save.
 *
 * Everything is plain text. The server removes markup and refuses a label
 * used twice, a unit it does not know, a picture or option that is not this
 * listing's, and any change while the listing is with the moderator; its
 * answer is shown beside the field it is about.
 *
 * Before approval this is saved on the listing and reviewed with the rest of
 * it. On a live listing the seller described, saving changes the product page
 * at once - the screen says so. On a live listing matched to somebody else's
 * page it is read only, and says why.
 */
import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, ErrorState, LoadingState, Spinner } from '@/components/ui';
import { ProductInformation } from '@/components/product-info/ProductInformation';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import {
  SPEC_UNITS,
  fetchListingContent,
  saveListingContent,
  type ListingContent,
  type ListingContentView,
} from '@/lib/seller';
import { SPEC_GROUP_KEYS, type SpecGroup, type SpecGroupKey } from '@/lib/types';

const EMPTY: ListingContent = { specifications: [], descriptionSections: [], variantOverrides: [] };

function move<T>(list: T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  if (item !== undefined) next.splice(target, 0, item);
  return next;
}

/** The server's field errors, by field path ("specifications.0.rows.1.label"). */
function fieldErrors(error: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (error instanceof ApiError) {
    for (const detail of error.details) {
      if (typeof detail.field === 'string' && typeof detail.code === 'string') map.set(detail.field, detail.code);
    }
  }
  return map;
}

/** What the preview shows: the seller's rows as a buyer would read them. */
function previewGroups(content: ListingContent): SpecGroup[] {
  return SPEC_GROUP_KEYS.flatMap((key) => {
    const rows = content.specifications
      .filter((group) => group.group === key)
      .flatMap((group) => group.rows)
      .filter((row) => row.label.trim() !== '' && row.value.trim() !== '')
      .map((row) => ({ label: row.label.trim(), value: row.value.trim(), unit: row.unit, highlight: row.highlight }));
    return rows.length === 0 ? [] : [{ group: key, rows }];
  });
}

function RowTools({
  index,
  count,
  onMove,
  onRemove,
  name,
  disabled,
}: {
  index: number;
  count: number;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  name: string;
  disabled: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const tool =
    'inline-flex min-h-9 items-center rounded-md border border-border px-2 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand';
  return (
    <div className="flex shrink-0 gap-1">
      <button
        type="button"
        className={tool}
        disabled={disabled || index === 0}
        onClick={() => {
          onMove(-1);
        }}
        aria-label={`${t('seller.content.moveUp')}: ${name}`}
      >
        ↑
      </button>
      <button
        type="button"
        className={tool}
        disabled={disabled || index === count - 1}
        onClick={() => {
          onMove(1);
        }}
        aria-label={`${t('seller.content.moveDown')}: ${name}`}
      >
        ↓
      </button>
      <button
        type="button"
        className={cx(tool, 'hover:text-danger')}
        disabled={disabled}
        onClick={onRemove}
        aria-label={`${t('seller.content.remove')}: ${name}`}
      >
        {t('seller.content.remove')}
      </button>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  error,
  multiline = false,
  disabled,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  multiline?: boolean;
  disabled: boolean;
  maxLength: number;
}): React.JSX.Element {
  const id = useId();
  const control =
    'mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus-visible:border-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand/40 disabled:opacity-60 aria-[invalid=true]:border-danger';
  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={id} className="block text-xs font-medium text-ink-muted">
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          rows={4}
          value={value}
          maxLength={maxLength}
          disabled={disabled}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : `${id}-error`}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className={control}
        />
      ) : (
        <input
          id={id}
          value={value}
          maxLength={maxLength}
          disabled={disabled}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : `${id}-error`}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className={control}
        />
      )}
      {error !== undefined && (
        <p id={`${id}-error`} className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled: boolean;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs font-medium text-ink-muted">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-2 text-sm text-ink disabled:opacity-60"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ListingContentEditor({ draftId }: { draftId: string }): React.JSX.Element {
  const { t } = useI18n();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['seller', 'listing-content', draftId], queryFn: () => fetchListingContent(draftId) });
  const [content, setContent] = useState<ListingContent>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const previewId = useId();

  useEffect(() => {
    if (query.data !== undefined && !dirty) setContent(query.data.content);
  }, [query.data, dirty]);

  const save = useMutation({
    mutationFn: () => saveListingContent(draftId, content),
    onSuccess: (view: ListingContentView) => {
      client.setQueryData(['seller', 'listing-content', draftId], view);
      setContent(view.content);
      setDirty(false);
    },
  });

  if (query.isLoading) return <LoadingState />;
  if (query.error !== null || query.data === undefined) {
    return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  }

  const view = query.data;
  const disabled = !view.editable || save.isPending;
  const errors = fieldErrors(save.error);
  const errorFor = (field: string): string | undefined => {
    const code = errors.get(field);
    return code === undefined ? undefined : t(`seller.content.error.${code}` as TranslationKey, { defaultValue: t('seller.content.error.generic') });
  };
  const update = (next: ListingContent): void => {
    setContent(next);
    setDirty(true);
  };
  const groupOptions = SPEC_GROUP_KEYS.map((key) => ({ value: key, label: t(`product.specGroup.${key}` as TranslationKey) }));
  const unitOptions = [{ value: '', label: t('seller.content.noUnit') }, ...SPEC_UNITS.map((unit) => ({ value: unit, label: unit }))];
  const unusedGroup = SPEC_GROUP_KEYS.find((key) => !content.specifications.some((group) => group.group === key));

  return (
    <Card title={t('seller.content.title')} description={t('seller.content.intro')} bodyClassName="space-y-6 px-5 pb-5 sm:px-6">
      {!view.editable && (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-ink">
          {view.appliesTo === 'live' ? t('seller.content.lockedShared') : t('seller.content.lockedReview')}
        </p>
      )}
      {view.editable && view.appliesTo === 'live' && (
        <p role="status" className="rounded-md bg-brand-soft px-3 py-2 text-sm text-ink">
          {t('seller.content.liveNote')}
        </p>
      )}

      {/* ---- Description sections ---- */}
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-ink">{t('seller.content.sections')}</legend>
        {content.descriptionSections.length === 0 && <p className="text-sm text-ink-subtle">{t('seller.content.empty')}</p>}
        {content.descriptionSections.map((section, index) => {
          const name = section.heading !== '' ? section.heading : t('seller.content.sectionN', { number: String(index + 1) });
          const set = (patch: Partial<typeof section>): void => {
            update({
              ...content,
              descriptionSections: content.descriptionSections.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)),
            });
          };
          return (
            <div key={index} className="space-y-2 rounded-lg border border-border-subtle p-3">
              <div className="flex flex-wrap items-end gap-2">
                <TextField label={t('seller.content.heading')} value={section.heading} maxLength={120} disabled={disabled} onChange={(value) => { set({ heading: value }); }} />
                <RowTools
                  index={index}
                  count={content.descriptionSections.length}
                  name={name}
                  disabled={disabled}
                  onMove={(by) => { update({ ...content, descriptionSections: move(content.descriptionSections, index, by) }); }}
                  onRemove={() => { update({ ...content, descriptionSections: content.descriptionSections.filter((_, at) => at !== index) }); }}
                />
              </div>
              <TextField
                label={t('seller.content.body')}
                value={section.body}
                multiline
                maxLength={8000}
                disabled={disabled}
                error={errorFor(`descriptionSections.${String(index)}`)}
                onChange={(value) => { set({ body: value }); }}
              />
              {view.images.length > 0 && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <SelectField
                    label={t('seller.content.image')}
                    value={section.imageMediaId ?? ''}
                    disabled={disabled}
                    options={[{ value: '', label: t('seller.content.noImage') }, ...view.images.map((image) => ({ value: image.id, label: image.fileName }))]}
                    onChange={(value) => { set({ imageMediaId: value === '' ? null : value }); }}
                  />
                  {section.imageMediaId !== null && (
                    <TextField label={t('seller.content.altText')} value={section.altText ?? ''} maxLength={255} disabled={disabled} onChange={(value) => { set({ altText: value === '' ? null : value }); }} />
                  )}
                </div>
              )}
              {errorFor(`descriptionSections.${String(index)}.imageMediaId`) !== undefined && (
                <p className="text-xs text-danger">{errorFor(`descriptionSections.${String(index)}.imageMediaId`)}</p>
              )}
            </div>
          );
        })}
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || content.descriptionSections.length >= 12}
          onClick={() => { update({ ...content, descriptionSections: [...content.descriptionSections, { heading: '', body: '', imageMediaId: null, altText: null }] }); }}
        >
          {t('seller.content.addSection')}
        </Button>
      </fieldset>

      {/* ---- Specification groups ---- */}
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-ink">{t('seller.content.groups')}</legend>
        {content.specifications.length === 0 && <p className="text-sm text-ink-subtle">{t('seller.content.empty')}</p>}
        {content.specifications.map((group, g) => {
          const groupName = t(`product.specGroup.${group.group}` as TranslationKey);
          const setGroup = (next: typeof group): void => {
            update({ ...content, specifications: content.specifications.map((entry, at) => (at === g ? next : entry)) });
          };
          return (
            <div key={`${group.group}-${String(g)}`} className="space-y-3 rounded-lg border border-border-subtle p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[12rem] flex-1">
                  <SelectField
                    label={t('seller.content.group')}
                    value={group.group}
                    disabled={disabled}
                    options={groupOptions}
                    onChange={(value) => { setGroup({ ...group, group: value as SpecGroupKey }); }}
                  />
                  {errorFor(`specifications.${String(g)}.group`) !== undefined && (
                    <p className="mt-1 text-xs text-danger">{errorFor(`specifications.${String(g)}.group`)}</p>
                  )}
                </div>
                <RowTools
                  index={g}
                  count={content.specifications.length}
                  name={groupName}
                  disabled={disabled}
                  onMove={(by) => { update({ ...content, specifications: move(content.specifications, g, by) }); }}
                  onRemove={() => { update({ ...content, specifications: content.specifications.filter((_, at) => at !== g) }); }}
                />
              </div>
              <ol className="space-y-2">
                {group.rows.map((row, r) => {
                  const rowName = row.label !== '' ? row.label : t('seller.content.rowN', { number: String(r + 1) });
                  const setRow = (patch: Partial<typeof row>): void => {
                    setGroup({ ...group, rows: group.rows.map((entry, at) => (at === r ? { ...entry, ...patch } : entry)) });
                  };
                  const path = `specifications.${String(g)}.rows.${String(r)}`;
                  return (
                    <li key={r} className="flex flex-col gap-2 border-t border-border-subtle pt-2 first:border-t-0 first:pt-0 lg:flex-row lg:items-end">
                      <TextField label={t('seller.content.label')} value={row.label} maxLength={128} disabled={disabled} error={errorFor(`${path}.label`)} onChange={(value) => { setRow({ label: value }); }} />
                      <TextField label={t('seller.content.value')} value={row.value} maxLength={512} disabled={disabled} error={errorFor(`${path}.value`)} onChange={(value) => { setRow({ value }); }} />
                      <div className="w-full lg:w-28">
                        <SelectField label={t('seller.content.unit')} value={row.unit ?? ''} disabled={disabled} options={unitOptions} onChange={(value) => { setRow({ unit: value === '' ? null : value }); }} />
                      </div>
                      <label className="flex min-h-10 items-center gap-2 text-xs text-ink-muted">
                        <input type="checkbox" checked={row.highlight} disabled={disabled} onChange={(event) => { setRow({ highlight: event.target.checked }); }} />
                        {t('seller.content.highlight')}
                      </label>
                      <RowTools
                        index={r}
                        count={group.rows.length}
                        name={rowName}
                        disabled={disabled}
                        onMove={(by) => { setGroup({ ...group, rows: move(group.rows, r, by) }); }}
                        onRemove={() => { setGroup({ ...group, rows: group.rows.filter((_, at) => at !== r) }); }}
                      />
                    </li>
                  );
                })}
              </ol>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => { setGroup({ ...group, rows: [...group.rows, { label: '', value: '', unit: null, highlight: false }] }); }}
              >
                {t('seller.content.addRow')}
              </Button>
            </div>
          );
        })}
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || unusedGroup === undefined}
          onClick={() => {
            if (unusedGroup === undefined) return;
            update({ ...content, specifications: [...content.specifications, { group: unusedGroup, rows: [{ label: '', value: '', unit: null, highlight: false }] }] });
          }}
        >
          {t('seller.content.addGroup')}
        </Button>
        {errorFor('specifications') !== undefined && <p className="text-xs text-danger">{errorFor('specifications')}</p>}
      </fieldset>

      {/* ---- Values for one option ---- */}
      {view.variants.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-ink">{t('seller.content.variantValues')}</legend>
          <p className="text-xs text-ink-muted">{t('seller.content.variantIntro')}</p>
          {content.variantOverrides.map((row, o) => {
            const set = (patch: Partial<typeof row>): void => {
              update({ ...content, variantOverrides: content.variantOverrides.map((entry, at) => (at === o ? { ...entry, ...patch } : entry)) });
            };
            const path = `variantOverrides.${String(o)}`;
            return (
              <div key={o} className="grid gap-2 rounded-lg border border-border-subtle p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_7rem_auto] lg:items-end">
                <SelectField label={t('seller.content.variant')} value={row.variantSignature} disabled={disabled} options={view.variants.map((variant) => ({ value: variant.signature, label: variant.name }))} onChange={(value) => { set({ variantSignature: value }); }} />
                <SelectField label={t('seller.content.group')} value={row.group} disabled={disabled} options={groupOptions} onChange={(value) => { set({ group: value as SpecGroupKey }); }} />
                <TextField label={t('seller.content.label')} value={row.label} maxLength={128} disabled={disabled} error={errorFor(`${path}.label`)} onChange={(value) => { set({ label: value }); }} />
                <TextField label={t('seller.content.value')} value={row.value} maxLength={512} disabled={disabled} error={errorFor(`${path}.value`)} onChange={(value) => { set({ value }); }} />
                <SelectField label={t('seller.content.unit')} value={row.unit ?? ''} disabled={disabled} options={unitOptions} onChange={(value) => { set({ unit: value === '' ? null : value }); }} />
                <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { update({ ...content, variantOverrides: content.variantOverrides.filter((_, at) => at !== o) }); }}>
                  {t('seller.content.remove')}
                </Button>
              </div>
            );
          })}
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              const first = view.variants[0];
              if (first === undefined) return;
              update({ ...content, variantOverrides: [...content.variantOverrides, { variantSignature: first.signature, group: 'TECHNICAL', label: '', value: '', unit: null }] });
            }}
          >
            {t('seller.content.addOverride')}
          </Button>
        </fieldset>
      )}

      {/* ---- Preview and save ---- */}
      <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle pt-4">
        <Button onClick={() => { save.mutate(); }} disabled={disabled || !dirty}>
          {save.isPending ? (
            <>
              <Spinner className="mr-1.5 size-4" /> {t('seller.content.saving')}
            </>
          ) : (
            t('seller.content.save')
          )}
        </Button>
        <Button variant="ghost" aria-expanded={preview} aria-controls={previewId} onClick={() => { setPreview((open) => !open); }}>
          {preview ? t('seller.content.hidePreview') : t('seller.content.preview')}
        </Button>
        <span role="status" className="text-sm">
          {save.isSuccess && !dirty && <span className="text-success">{t('seller.content.saved')}</span>}
          {save.error !== null && (
            <span className="text-danger">{errorMessage(t, save.error, t('seller.content.error.generic'))}</span>
          )}
        </span>
      </div>
      <div id={previewId} hidden={!preview} className="rounded-lg border border-dashed border-border p-4">
        {preview && (
          <ProductInformation
            specifications={previewGroups(content)}
            descriptionSections={content.descriptionSections
              .filter((section) => section.heading.trim() !== '' || section.body.trim() !== '')
              .map((section) => ({ heading: section.heading.trim(), body: section.body.trim(), image: null }))}
            description={null}
            descriptionHtml={null}
          />
        )}
      </div>
    </Card>
  );
}
