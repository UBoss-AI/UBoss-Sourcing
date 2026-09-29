/**
 * Ownership, registrations and exports: the part of the seller application
 * that says what the business is in law, who owns or controls it, whether it
 * already exports, and what it means to sell.
 *
 * Drawn inside the "Identity and documents" step, because that is the step it
 * answers to - the server judges it there, in the same "Still needed" message
 * as the rest of the step, so the tick and this panel can never disagree.
 *
 * Saved as a whole with one button rather than field by field: the ownership
 * total is a rule about the whole list, and saving half a list is how an
 * application ends up at 140%. Percentages are converted to basis points as
 * text, never through a float.
 *
 * The owners listed are people outside the organisation. The panel says
 * plainly that only the marketplace's reviewers see them.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale } from '@/app/locale-context';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Select,
} from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { ApiError, api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import {
  SELLER_LEGAL_FORMS,
  basisPointsToPercent,
  fetchKyb,
  percentToBasisPoints,
  saveKyb,
  type KybInput,
  type KybView,
  type SellerLegalForm,
} from '@/lib/seller-kyb';
import type { CategoryNode } from '@/lib/types';

interface OwnerDraft {
  /** Local only, for React keys. */
  key: string;
  id: string | null;
  fullName: string;
  nationality: string;
  share: string;
  role: string;
  isControllingPerson: boolean;
  isPoliticallyExposed: boolean;
}

interface Draft {
  legalForm: SellerLegalForm | '';
  udyamNumber: string;
  iecNumber: string;
  exportCapable: boolean;
  exportMarkets: string[];
  yearsExporting: string;
  categories: { id: string; name: string }[];
  owners: OwnerDraft[];
}

let ownerSeed = 0;
const nextKey = (): string => `owner-${String((ownerSeed += 1))}`;

function draftFrom(view: KybView): Draft {
  return {
    legalForm: view.legalForm ?? '',
    udyamNumber: view.udyamNumber ?? '',
    iecNumber: view.iecNumber ?? '',
    exportCapable: view.exportCapable,
    exportMarkets: view.exportMarkets,
    yearsExporting: view.yearsExporting === null ? '' : String(view.yearsExporting),
    categories: view.intendedCategories,
    owners: view.beneficialOwners.map((owner) => ({
      // The server id, so a reload of the same owner keeps the same row.
      key: owner.id,
      id: owner.id,
      fullName: owner.fullName,
      nationality: owner.nationality ?? '',
      share: basisPointsToPercent(owner.ownershipBasisPoints),
      role: owner.role ?? '',
      isControllingPerson: owner.isControllingPerson,
      isPoliticallyExposed: owner.isPoliticallyExposed,
    })),
  };
}

function blankOwner(): OwnerDraft {
  return {
    key: nextKey(),
    id: null,
    fullName: '',
    nationality: '',
    share: '',
    role: '',
    isControllingPerson: false,
    isPoliticallyExposed: false,
  };
}

/** Every category in the tree, flattened, with its depth for indenting. */
function flatten(nodes: readonly CategoryNode[], out: { id: string; name: string; depth: number }[] = []) {
  for (const node of nodes) {
    out.push({ id: node.id, name: node.name, depth: node.depth });
    flatten(node.children, out);
  }
  return out;
}

export function SellerOwnershipPanel(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['seller', 'kyb'], queryFn: fetchKyb });

  if (query.isPending) {
    return (
      <Card>
        <div className="px-6 py-5">
          <LoadingState label={t('sellerKyb.loading')} />
        </div>
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <div className="px-6 py-5">
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        </div>
      </Card>
    );
  }

  return <OwnershipForm view={query.data} />;
}

function OwnershipForm({ view }: { view: KybView }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const locale = useLocale();

  const [draft, setDraft] = useState<Draft>(() => draftFrom(view));
  const [market, setMarket] = useState('');
  const [category, setCategory] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // A fresh answer from the server (after a save, or a reload) replaces the
  // form, so the ids of newly created owners are the ones sent next time.
  useEffect(() => {
    setDraft(draftFrom(view));
  }, [view]);

  const categoriesQuery = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/catalog/categories'),
  });
  const categoryOptions = useMemo(() => flatten(categoriesQuery.data?.categories ?? []), [categoriesQuery.data]);

  const countryName = (code: string): string =>
    locale.countries.find((entry) => entry.code === code)?.name ?? code;

  const shares = draft.owners.map((owner) => percentToBasisPoints(owner.share));
  const total = shares.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const isEditable = view.isEditable;

  const errorFor = (field: string): string | undefined => fieldErrors[field];

  const mutation = useMutation({
    mutationFn: (input: KybInput) => saveKyb(input),
    onSuccess: async (saved) => {
      setFieldErrors({});
      client.setQueryData(['seller', 'kyb'], saved);
      await client.invalidateQueries({ queryKey: ['seller', 'onboarding'] });
      toast.success(t('sellerKyb.saved'));
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.details.length > 0) {
        const next: Record<string, string> = {};
        for (const detail of error.details) {
          if (detail.field === undefined) continue;
          next[detail.field] ??= t(`sellerKyb.error.${detail.code ?? 'generic'}` as TranslationKey, {
            defaultValue: t('sellerKyb.error.generic'),
          });
        }
        setFieldErrors(next);
      }
      toast.error(errorMessage(t, error, t('sellerKyb.saveFailed')));
    },
  });

  const update = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const updateOwner = (key: string, patch: Partial<OwnerDraft>): void => {
    setDraft((current) => ({
      ...current,
      owners: current.owners.map((owner) => (owner.key === key ? { ...owner, ...patch } : owner)),
    }));
  };

  const submit = (): void => {
    // Checked here first so the seller hears about a mistyped share at once;
    // the server checks it again and is the one that decides.
    const local: Record<string, string> = {};
    draft.owners.forEach((owner, index) => {
      if (shares[index] === null) local[`beneficialOwners.${String(index)}.ownershipBasisPoints`] = t('sellerKyb.owners.shareInvalid');
      if (owner.fullName.trim().length < 2) local[`beneficialOwners.${String(index)}.fullName`] = t('sellerKyb.error.TOO_SHORT');
    });
    const years = draft.yearsExporting.trim();
    if (draft.exportCapable && years.length > 0 && !/^\d{1,3}$/.test(years)) {
      local['yearsExporting'] = t('sellerKyb.error.generic');
    }
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      return;
    }

    mutation.mutate({
      legalForm: draft.legalForm === '' ? null : draft.legalForm,
      udyamNumber: view.isIndia && draft.udyamNumber.trim().length > 0 ? draft.udyamNumber.trim() : null,
      iecNumber: view.isIndia && draft.iecNumber.trim().length > 0 ? draft.iecNumber.trim() : null,
      exportCapable: draft.exportCapable,
      exportMarkets: draft.exportCapable ? draft.exportMarkets : [],
      yearsExporting: draft.exportCapable && years.length > 0 ? Number(years) : null,
      intendedCategoryIds: draft.categories.map((entry) => entry.id),
      beneficialOwners: draft.owners.map((owner, index) => ({
        id: owner.id,
        fullName: owner.fullName.trim(),
        nationality: owner.nationality === '' ? null : owner.nationality,
        ownershipBasisPoints: shares[index] ?? 0,
        role: owner.role.trim().length === 0 ? null : owner.role.trim(),
        isControllingPerson: owner.isControllingPerson,
        isPoliticallyExposed: owner.isPoliticallyExposed,
      })),
    });
  };

  return (
    <Card>
      <form
        className="space-y-6 px-4 py-5 sm:px-6"
        aria-labelledby="seller-kyb-title"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        noValidate
      >
        <div className="min-w-0">
          <h2 id="seller-kyb-title" className="text-title-sm text-ink">
            {t('sellerKyb.title')}
          </h2>
          <p className="mt-1 max-w-prose text-sm text-ink-muted">{t('sellerKyb.intro')}</p>
        </div>

        {view.outstanding.length > 0 && (
          <div role="status" className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3">
            <p className="text-sm font-medium text-ink">{t('sellerKyb.outstandingTitle')}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink">
              {view.outstanding.map((gap) => (
                <li key={gap.code}>
                  {t(`sellerKyb.gap.${gap.code}` as TranslationKey, { name: view.registrationNumberName ?? '' })}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!isEditable && (
          <p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-sm text-ink-muted">
            {t('sellerKyb.locked')}
          </p>
        )}

        <fieldset disabled={!isEditable || mutation.isPending} className="min-w-0 space-y-6">
          {/* --- Legal form ------------------------------------------------- */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('sellerKyb.legalForm.label')} hint={t('sellerKyb.legalForm.hint')} error={errorFor('legalForm')} required>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={errorFor('legalForm') !== undefined}
                  value={draft.legalForm}
                  onChange={(event) => {
                    update({ legalForm: event.target.value as SellerLegalForm | '' });
                  }}
                >
                  <option value="">{t('sellerKyb.legalForm.choose')}</option>
                  {SELLER_LEGAL_FORMS.map((form) => (
                    <option key={form} value={form}>
                      {t(`sellerKyb.legalForm.${form}` as TranslationKey)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {view.registrationNumberName !== null && (
            <p className="text-sm text-ink-muted">
              {t(`sellerKyb.registrationNeeded.${view.registrationNumberName}` as TranslationKey)}
            </p>
          )}

          {/* --- India's registrations -------------------------------------- */}
          {view.isIndia && (
            <section aria-labelledby="seller-kyb-registrations" className="space-y-3">
              <h3 id="seller-kyb-registrations" className="text-sm font-semibold text-ink">
                {t('sellerKyb.registrations.title')}
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('sellerKyb.udyam.label')} hint={t('sellerKyb.udyam.hint')} error={errorFor('udyamNumber')}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      invalid={errorFor('udyamNumber') !== undefined}
                      autoComplete="off"
                      maxLength={32}
                      value={draft.udyamNumber}
                      onChange={(event) => {
                        update({ udyamNumber: event.target.value });
                      }}
                    />
                  )}
                </Field>
                <Field label={t('sellerKyb.iec.label')} hint={t('sellerKyb.iec.hint')} error={errorFor('iecNumber')}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      invalid={errorFor('iecNumber') !== undefined}
                      autoComplete="off"
                      maxLength={16}
                      value={draft.iecNumber}
                      onChange={(event) => {
                        update({ iecNumber: event.target.value });
                      }}
                    />
                  )}
                </Field>
              </div>
            </section>
          )}

          {/* --- Exports ---------------------------------------------------- */}
          <section aria-labelledby="seller-kyb-exports" className="space-y-3">
            <h3 id="seller-kyb-exports" className="text-sm font-semibold text-ink">
              {t('sellerKyb.exports.title')}
            </h3>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0"
                checked={draft.exportCapable}
                onChange={(event) => {
                  update({ exportCapable: event.target.checked });
                }}
              />
              <span>{t('sellerKyb.exports.capable')}</span>
            </label>

            {draft.exportCapable && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-1 basis-48">
                    <Field label={t('sellerKyb.exports.markets')} error={errorFor('exportMarkets')}>
                      {({ inputId, describedBy }) => (
                        <Select
                          id={inputId}
                          aria-describedby={describedBy}
                          invalid={errorFor('exportMarkets') !== undefined}
                          value={market}
                          onChange={(event) => {
                            setMarket(event.target.value);
                          }}
                        >
                          <option value="">{t('sellerKyb.exports.chooseCountry')}</option>
                          {locale.countries
                            .filter((entry) => !draft.exportMarkets.includes(entry.code))
                            .map((entry) => (
                              <option key={entry.code} value={entry.code}>
                                {entry.name}
                              </option>
                            ))}
                        </Select>
                      )}
                    </Field>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={market === ''}
                    onClick={() => {
                      update({ exportMarkets: [...draft.exportMarkets, market] });
                      setMarket('');
                    }}
                  >
                    {t('sellerKyb.exports.addMarket')}
                  </Button>
                </div>
                {draft.exportMarkets.length === 0 ? (
                  <p className="text-xs text-ink-muted">{t('sellerKyb.exports.none')}</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {draft.exportMarkets.map((code) => (
                      <li key={code} className="flex items-center gap-1 rounded-full border border-border bg-surface-sunken py-0.5 pl-3 pr-1 text-xs text-ink">
                        <span>{countryName(code)}</span>
                        <button
                          type="button"
                          className="rounded-full px-1.5 text-ink-muted hover:text-danger"
                          aria-label={t('sellerKyb.remove', { name: countryName(code) })}
                          onClick={() => {
                            update({ exportMarkets: draft.exportMarkets.filter((entry) => entry !== code) });
                          }}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="max-w-40">
                  <Field label={t('sellerKyb.exports.years')} error={errorFor('yearsExporting')}>
                    {({ inputId, describedBy }) => (
                      <Input
                        id={inputId}
                        aria-describedby={describedBy}
                        invalid={errorFor('yearsExporting') !== undefined}
                        inputMode="numeric"
                        value={draft.yearsExporting}
                        onChange={(event) => {
                          update({ yearsExporting: event.target.value });
                        }}
                      />
                    )}
                  </Field>
                </div>
              </div>
            )}
          </section>

          {/* --- Categories ------------------------------------------------- */}
          <section aria-labelledby="seller-kyb-categories" className="space-y-3">
            <h3 id="seller-kyb-categories" className="text-sm font-semibold text-ink">
              {t('sellerKyb.categories.title')}
            </h3>
            {categoriesQuery.isError ? (
              <p role="alert" className="text-sm text-danger">
                {t('sellerKyb.categories.loadFailed')}
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1 basis-48">
                  <Field label={t('sellerKyb.categories.choose')} hint={t('sellerKyb.categories.hint')} error={errorFor('intendedCategoryIds')}>
                    {({ inputId, describedBy }) => (
                      <Select
                        id={inputId}
                        aria-describedby={describedBy}
                        invalid={errorFor('intendedCategoryIds') !== undefined}
                        value={category}
                        disabled={categoriesQuery.isPending}
                        onChange={(event) => {
                          setCategory(event.target.value);
                        }}
                      >
                        <option value="">{t('sellerKyb.categories.choose')}</option>
                        {categoryOptions
                          .filter((entry) => !draft.categories.some((chosen) => chosen.id === entry.id))
                          .map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {`${'— '.repeat(entry.depth)}${entry.name}`}
                            </option>
                          ))}
                      </Select>
                    )}
                  </Field>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={category === ''}
                  onClick={() => {
                    const chosen = categoryOptions.find((entry) => entry.id === category);
                    if (chosen !== undefined) {
                      update({ categories: [...draft.categories, { id: chosen.id, name: chosen.name }] });
                    }
                    setCategory('');
                  }}
                >
                  {t('sellerKyb.categories.add')}
                </Button>
              </div>
            )}
            {draft.categories.length === 0 ? (
              <p className="text-xs text-ink-muted">{t('sellerKyb.categories.none')}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {draft.categories.map((entry) => (
                  <li key={entry.id} className="flex items-center gap-1 rounded-full border border-border bg-surface-sunken py-0.5 pl-3 pr-1 text-xs text-ink">
                    <span className="break-all">{entry.name}</span>
                    <button
                      type="button"
                      className="rounded-full px-1.5 text-ink-muted hover:text-danger"
                      aria-label={t('sellerKyb.remove', { name: entry.name })}
                      onClick={() => {
                        update({ categories: draft.categories.filter((chosen) => chosen.id !== entry.id) });
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* --- Owners ----------------------------------------------------- */}
          <section aria-labelledby="seller-kyb-owners" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="seller-kyb-owners" className="text-sm font-semibold text-ink">
                {t('sellerKyb.owners.title')}
              </h3>
              {view.policy.beneficialOwnersRequired && <Badge tone="neutral">{t('sellerKyb.owners.required')}</Badge>}
            </div>
            <p className="max-w-prose text-sm text-ink-muted">{t('sellerKyb.owners.hint')}</p>
            {errorFor('beneficialOwners') !== undefined && (
              <p role="alert" className="text-sm font-medium text-danger">
                {errorFor('beneficialOwners')}
              </p>
            )}

            {draft.owners.length === 0 && <p className="text-xs text-ink-muted">{t('sellerKyb.owners.none')}</p>}

            <ol className="space-y-4">
              {draft.owners.map((owner, index) => {
                const at = `beneficialOwners.${String(index)}`;
                return (
                  <li key={owner.key} className="min-w-0 rounded-lg border border-border px-3 py-3 sm:px-4">
                    <fieldset className="min-w-0 space-y-3">
                      <legend className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
                        {t('sellerKyb.owners.person', { number: String(index + 1) })}
                      </legend>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={t('sellerKyb.owners.fullName')} error={errorFor(`${at}.fullName`)} required>
                          {({ inputId, describedBy }) => (
                            <Input
                              id={inputId}
                              aria-describedby={describedBy}
                              invalid={errorFor(`${at}.fullName`) !== undefined}
                              autoComplete="off"
                              maxLength={160}
                              value={owner.fullName}
                              onChange={(event) => {
                                updateOwner(owner.key, { fullName: event.target.value });
                              }}
                            />
                          )}
                        </Field>
                        <Field label={t('sellerKyb.owners.nationality')} error={errorFor(`${at}.nationality`)}>
                          {({ inputId, describedBy }) => (
                            <Select
                              id={inputId}
                              aria-describedby={describedBy}
                              invalid={errorFor(`${at}.nationality`) !== undefined}
                              value={owner.nationality}
                              onChange={(event) => {
                                updateOwner(owner.key, { nationality: event.target.value });
                              }}
                            >
                              <option value="">{t('sellerKyb.owners.nationalityUnknown')}</option>
                              {locale.countries.map((entry) => (
                                <option key={entry.code} value={entry.code}>
                                  {entry.name}
                                </option>
                              ))}
                            </Select>
                          )}
                        </Field>
                        <Field
                          label={t('sellerKyb.owners.share')}
                          hint={t('sellerKyb.owners.shareHint')}
                          error={errorFor(`${at}.ownershipBasisPoints`)}
                          required
                        >
                          {({ inputId, describedBy }) => (
                            <Input
                              id={inputId}
                              aria-describedby={describedBy}
                              invalid={errorFor(`${at}.ownershipBasisPoints`) !== undefined}
                              inputMode="decimal"
                              value={owner.share}
                              onChange={(event) => {
                                updateOwner(owner.key, { share: event.target.value });
                              }}
                            />
                          )}
                        </Field>
                        <Field label={t('sellerKyb.owners.role')}>
                          {({ inputId, describedBy }) => (
                            <Input
                              id={inputId}
                              aria-describedby={describedBy}
                              maxLength={120}
                              value={owner.role}
                              onChange={(event) => {
                                updateOwner(owner.key, { role: event.target.value });
                              }}
                            />
                          )}
                        </Field>
                      </div>
                      <label className="flex items-start gap-2 text-sm text-ink">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 shrink-0"
                          checked={owner.isControllingPerson}
                          onChange={(event) => {
                            updateOwner(owner.key, { isControllingPerson: event.target.checked });
                          }}
                        />
                        <span>{t('sellerKyb.owners.controlling')}</span>
                      </label>
                      <label className="flex items-start gap-2 text-sm text-ink">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 shrink-0"
                          checked={owner.isPoliticallyExposed}
                          onChange={(event) => {
                            updateOwner(owner.key, { isPoliticallyExposed: event.target.checked });
                          }}
                        />
                        <span>{t('sellerKyb.owners.pep')}</span>
                      </label>
                      <div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            update({ owners: draft.owners.filter((entry) => entry.key !== owner.key) });
                          }}
                        >
                          {t('sellerKyb.remove', { name: owner.fullName.trim().length > 0 ? owner.fullName : t('sellerKyb.owners.person', { number: String(index + 1) }) })}
                        </Button>
                      </div>
                    </fieldset>
                  </li>
                );
              })}
            </ol>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  update({ owners: [...draft.owners, blankOwner()] });
                }}
              >
                {t('sellerKyb.owners.add')}
              </Button>
              {draft.owners.length > 0 && (
                <p className={total > 10_000 ? 'text-sm font-medium text-danger' : 'text-sm text-ink-muted'} aria-live="polite">
                  {total > 10_000
                    ? t('sellerKyb.owners.totalOver', { percent: basisPointsToPercent(total) })
                    : t('sellerKyb.owners.total', { percent: basisPointsToPercent(total) })}
                </p>
              )}
            </div>
          </section>
        </fieldset>

        <p className="max-w-prose text-xs leading-relaxed text-ink-muted">{t('sellerKyb.bankEvidence')}</p>

        {isEditable && (
          <div className="flex justify-end">
            <Button type="submit" variant="primary" isLoading={mutation.isPending}>
              {t('sellerKyb.save')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
