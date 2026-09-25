/**
 * Seller Hub: how many pieces of this option fit in a 20-ft and a 40-ft
 * container.
 *
 * Per listing, and a listing is one option of a product - so a 100-piece box
 * and a 500-piece bulk pack each state their own figure, and a buyer switching
 * option on the product page never sees the other one's.
 *
 * The seller states the carton and how many cartons (or pallets) go in each
 * container. Everything that follows - pieces per container, cargo weight
 * against the configured payload limit, the share of the container's space,
 * and the system's own estimate - comes back from the server's preview, which
 * is the same check the save is held to. An impossible or unsafe figure is
 * refused, and a changed figure has to be verified again before buyers can
 * order against it. Preorders already sent keep the capacity they were made
 * with.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatIsoDate } from '@/lib/calendar-date';
import {
  fetchContainerLoading,
  gramsToKg,
  previewContainerLoading,
  saveContainerLoading,
  type ContainerLoadingInput,
  type ContainerLoadingView,
  type LoadingIssue,
} from '@/lib/container-loading';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { CONTAINER_SIZES, type ContainerSize } from '@/lib/preorders';

interface SizeDraft {
  enabled: boolean;
  cartons: string;
  pallets: string;
  verified: boolean;
}

interface Draft {
  piecesPerCarton: string;
  length: string;
  width: string;
  height: string;
  dimensionUnit: ContainerLoadingInput['dimensionUnit'];
  weight: string;
  weightUnit: ContainerLoadingInput['weightUnit'];
  maxStackLayers: string;
  loadingMethod: ContainerLoadingInput['loadingMethod'];
  cartonsPerPallet: string;
  sizes: Record<ContainerSize, SizeDraft>;
  notes: string;
}

const EMPTY_SIZE: SizeDraft = { enabled: false, cartons: '', pallets: '', verified: false };

function draftFrom(view: ContainerLoadingView | undefined): Draft {
  const size = (unit: ContainerSize): SizeDraft => {
    const saved = view?.sizes?.[unit] ?? null;
    return saved === null || saved.cartonsPerContainer === null
      ? EMPTY_SIZE
      : {
          enabled: true,
          cartons: String(saved.cartonsPerContainer),
          pallets: saved.palletsPerContainer === null ? '' : String(saved.palletsPerContainer),
          verified: false,
        };
  };
  const carton = view?.carton;
  return {
    piecesPerCarton: carton === undefined ? '' : String(carton.piecesPerCarton),
    length: carton === undefined ? '' : String(carton.lengthMm),
    width: carton === undefined ? '' : String(carton.widthMm),
    height: carton === undefined ? '' : String(carton.heightMm),
    dimensionUnit: 'MM',
    // Grams to kilograms for the form: a weight, not money, so a decimal is fine.
    weight: carton === undefined ? '' : String(Number(carton.grossWeightGrams) / 1000),
    weightUnit: 'KG',
    maxStackLayers: carton?.maxStackLayers === null || carton === undefined ? '' : String(carton.maxStackLayers),
    loadingMethod: view?.loadingMethod === 'PALLET_LOADED' ? 'PALLET_LOADED' : 'CARTON_LOADED',
    cartonsPerPallet:
      view?.cartonsPerPallet === null || view?.cartonsPerPallet === undefined ? '' : String(view.cartonsPerPallet),
    sizes: { CONTAINER_20_FT: size('CONTAINER_20_FT'), CONTAINER_40_FT: size('CONTAINER_40_FT') },
    notes: view?.notes ?? '',
  };
}

const whole = (value: string): number | null => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);
const decimal = (value: string): number | null =>
  /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : null;

function toInput(draft: Draft, version: number | null): ContainerLoadingInput | null {
  const pieces = whole(draft.piecesPerCarton);
  const length = decimal(draft.length);
  const width = decimal(draft.width);
  const height = decimal(draft.height);
  const weight = decimal(draft.weight);
  if (pieces === null || length === null || width === null || height === null || weight === null) return null;
  if (pieces <= 0 || length <= 0 || width <= 0 || height <= 0 || weight <= 0) return null;

  const size = (entry: SizeDraft) =>
    entry.enabled
      ? { cartonsPerContainer: whole(entry.cartons), palletsPerContainer: whole(entry.pallets), verified: entry.verified }
      : null;

  return {
    piecesPerCarton: pieces,
    cartonLength: length,
    cartonWidth: width,
    cartonHeight: height,
    dimensionUnit: draft.dimensionUnit,
    grossWeightPerCarton: weight,
    weightUnit: draft.weightUnit,
    maxStackLayers: whole(draft.maxStackLayers),
    loadingMethod: draft.loadingMethod,
    cartonsPerPallet: draft.loadingMethod === 'PALLET_LOADED' ? whole(draft.cartonsPerPallet) : null,
    twentyFt: size(draft.sizes.CONTAINER_20_FT),
    fortyFt: size(draft.sizes.CONTAINER_40_FT),
    notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
    expectedVersion: version,
  };
}

export function SellerContainerLoadingPanel({ offerId }: { offerId: string }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const saved = useQuery({
    queryKey: ['seller', 'container-loading', offerId],
    queryFn: () => fetchContainerLoading(offerId),
  });

  const [draft, setDraft] = useState<Draft>(() => draftFrom(undefined));
  useEffect(() => {
    if (saved.data !== undefined) setDraft(draftFrom(saved.data));
  }, [saved.data]);

  const version = saved.data?.version ?? null;
  const input = toInput(draft, version);
  const [settled, setSettled] = useState(input);
  const inputKey = input === null ? null : JSON.stringify(input);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettled(inputKey === null ? null : (JSON.parse(inputKey) as ContainerLoadingInput));
    }, 350);
    return () => {
      window.clearTimeout(timer);
    };
  }, [inputKey]);

  const preview = useQuery({
    queryKey: ['seller', 'container-loading', offerId, 'preview', settled === null ? null : JSON.stringify(settled)],
    queryFn: () => previewContainerLoading(offerId, settled as ContainerLoadingInput),
    enabled: settled !== null,
    retry: false,
  });
  const previewCurrent = settled !== null && JSON.stringify(settled) === inputKey;

  const save = useMutation({
    mutationFn: () => saveContainerLoading(offerId, input as ContainerLoadingInput),
    onSuccess: (view) => {
      queryClient.setQueryData(['seller', 'container-loading', offerId], view);
      toast.success(t('sellerContainer.saved'));
    },
  });

  const issueText = (issue: LoadingIssue): string => {
    const key = `sellerContainer.issue.${issue.code}` as TranslationKey;
    const text = t(key, {
      weight: formatNumber(typeof issue.meta?.['payloadKg'] === 'number' ? issue.meta['payloadKg'] : null),
      max: formatNumber(typeof issue.meta?.['maxPayloadKg'] === 'number' ? issue.meta['maxPayloadKg'] : null),
    });
    return text === key ? issue.message : text;
  };

  const issues = previewCurrent ? (preview.data?.issues ?? []) : [];
  const cartonIssues = issues.filter((issue) => !issue.field.includes('.'));
  const palletised = draft.loadingMethod === 'PALLET_LOADED';

  const setSize = (unit: ContainerSize, patch: Partial<SizeDraft>): void => {
    setDraft((current) => ({
      ...current,
      sizes: { ...current.sizes, [unit]: { ...current.sizes[unit], ...patch } },
    }));
  };

  const numberField = (
    label: string,
    value: string,
    onChange: (next: string) => void,
    options: { decimal?: boolean; hint?: string } = {},
  ): React.JSX.Element => (
    <Field label={label} {...(options.hint === undefined ? {} : { hint: options.hint })}>
      {({ inputId, describedBy }) => (
        <Input
          id={inputId}
          aria-describedby={describedBy}
          inputMode={options.decimal === true ? 'decimal' : 'numeric'}
          value={value}
          onChange={(event) => {
            onChange(event.currentTarget.value.replace(options.decimal === true ? /[^\d.]/g : /[^\d]/g, ''));
          }}
        />
      )}
    </Field>
  );

  return (
    <Card title={t('sellerContainer.title')} description={t('sellerContainer.description')}>
      {saved.isPending ? (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <Spinner />
          {t('sellerContainer.loading')}
        </p>
      ) : (
        <div className="space-y-5">
          <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <legend className="mb-2 text-sm font-semibold text-ink">{t('sellerContainer.carton')}</legend>
            {numberField(t('sellerContainer.piecesPerCarton'), draft.piecesPerCarton, (next) => {
              setDraft((current) => ({ ...current, piecesPerCarton: next }));
            })}
            {numberField(t('sellerContainer.length'), draft.length, (next) => {
              setDraft((current) => ({ ...current, length: next }));
            }, { decimal: true })}
            {numberField(t('sellerContainer.width'), draft.width, (next) => {
              setDraft((current) => ({ ...current, width: next }));
            }, { decimal: true })}
            {numberField(t('sellerContainer.height'), draft.height, (next) => {
              setDraft((current) => ({ ...current, height: next }));
            }, { decimal: true })}
            <Field label={t('sellerContainer.dimensionUnit')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={draft.dimensionUnit}
                  onChange={(event) => {
                    const unit = event.currentTarget.value as Draft['dimensionUnit'];
                    setDraft((current) => ({ ...current, dimensionUnit: unit }));
                  }}
                >
                  <option value="MM">mm</option>
                  <option value="CM">cm</option>
                  <option value="M">m</option>
                  <option value="IN">in</option>
                </Select>
              )}
            </Field>
            {numberField(t('sellerContainer.grossWeight'), draft.weight, (next) => {
              setDraft((current) => ({ ...current, weight: next }));
            }, { decimal: true })}
            <Field label={t('sellerContainer.weightUnit')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={draft.weightUnit}
                  onChange={(event) => {
                    const unit = event.currentTarget.value as Draft['weightUnit'];
                    setDraft((current) => ({ ...current, weightUnit: unit }));
                  }}
                >
                  <option value="KG">kg</option>
                  <option value="G">g</option>
                  <option value="LB">lb</option>
                </Select>
              )}
            </Field>
            {numberField(t('sellerContainer.maxStackLayers'), draft.maxStackLayers, (next) => {
              setDraft((current) => ({ ...current, maxStackLayers: next }));
            }, { hint: t('sellerContainer.maxStackHint') })}
            <Field label={t('sellerContainer.loadingMethod')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={draft.loadingMethod}
                  onChange={(event) => {
                    const method = event.currentTarget.value as Draft['loadingMethod'];
                    setDraft((current) => ({ ...current, loadingMethod: method }));
                  }}
                >
                  <option value="CARTON_LOADED">{t('sellerContainer.method.CARTON_LOADED')}</option>
                  <option value="PALLET_LOADED">{t('sellerContainer.method.PALLET_LOADED')}</option>
                </Select>
              )}
            </Field>
            {palletised &&
              numberField(t('sellerContainer.cartonsPerPallet'), draft.cartonsPerPallet, (next) => {
                setDraft((current) => ({ ...current, cartonsPerPallet: next }));
              })}
            {cartonIssues.map((issue) => (
              <p key={`${issue.field}-${issue.code}`} role="alert" className="text-xs text-danger sm:col-span-2 lg:col-span-4">
                {issueText(issue)}
              </p>
            ))}
          </fieldset>

          <div className="grid gap-4 lg:grid-cols-2">
            {CONTAINER_SIZES.map((unit) => {
              const entry = draft.sizes[unit];
              const prefix = unit === 'CONTAINER_20_FT' ? 'twentyFt.' : 'fortyFt.';
              const result = previewCurrent ? (preview.data?.sizes?.[unit] ?? null) : null;
              const stored = saved.data?.sizes?.[unit] ?? null;
              const limits = saved.data?.limits?.[unit];
              const sizeIssues = issues.filter((issue) => issue.field.startsWith(prefix));
              return (
                <fieldset key={unit} className="rounded-md border border-border-subtle p-4">
                  <legend className="px-1 text-sm font-semibold text-ink">{t(`sellerContainer.size.${unit}` as TranslationKey)}</legend>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      className="size-4 rounded border-border"
                      checked={entry.enabled}
                      onChange={(event) => {
                        setSize(unit, { enabled: event.currentTarget.checked });
                      }}
                    />
                    {t('sellerContainer.offerSize')}
                  </label>

                  {stored?.source !== null && stored?.source !== undefined && (
                    <p className="mt-2">
                      <Badge tone={stored.source === 'SELLER_VERIFIED' ? 'success' : 'warning'}>
                        {stored.source === 'SELLER_VERIFIED' && stored.verifiedAt !== null
                          ? t('sellerContainer.source.SELLER_VERIFIED', {
                              date: formatIsoDate(stored.verifiedAt.slice(0, 10), intlLocale, { dateStyle: 'medium' }),
                            })
                          : t('sellerContainer.source.CALCULATED_ESTIMATE')}
                      </Badge>
                    </p>
                  )}

                  {entry.enabled && (
                    <div className="mt-3 space-y-3">
                      {palletised
                        ? numberField(t('sellerContainer.palletsPerContainer'), entry.pallets, (next) => {
                            setSize(unit, { pallets: next });
                          })
                        : numberField(t('sellerContainer.cartonsPerContainer'), entry.cartons, (next) => {
                            setSize(unit, { cartons: next });
                          })}

                      <dl aria-live="polite" className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
                        <dt className="text-ink-muted">{t('sellerContainer.resultingPieces')}</dt>
                        <dd className="text-right font-semibold tabular-nums text-ink">
                          {result === null ? '—' : formatNumber(result.piecesPerContainer)}
                        </dd>
                      </dl>
                      {result !== null && limits !== undefined && (
                        <p className="text-xs text-ink-muted">
                          {t('sellerContainer.payload', {
                            weight: formatNumber(gramsToKg(result.payloadGrams)),
                            max: formatNumber(gramsToKg(limits.maxPayloadGrams)),
                          })}
                          {result.volumeUsePercent !== null &&
                            ` · ${t('sellerContainer.volumeUse', { percent: formatNumber(result.volumeUsePercent) })}`}
                        </p>
                      )}
                      {result?.estimate !== null && result?.estimate !== undefined && (
                        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                          <span>
                            {t('sellerContainer.estimate', {
                              cartons: formatNumber(result.estimate.cartons),
                              pieces: formatNumber(result.estimate.pieces),
                              limit: t(`sellerContainer.limitedBy.${result.estimate.limitedBy}` as TranslationKey),
                            })}
                          </span>
                          {!palletised && String(result.estimate.cartons) !== entry.cartons && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setSize(unit, { cartons: String(result.estimate?.cartons ?? ''), verified: false });
                              }}
                            >
                              {t('sellerContainer.useEstimate')}
                            </Button>
                          )}
                        </div>
                      )}
                      {sizeIssues.map((issue) => (
                        <p key={`${issue.field}-${issue.code}`} role="alert" className="text-xs text-danger">
                          {issueText(issue)}
                        </p>
                      ))}
                      <label className="flex items-start gap-2 text-sm text-ink">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 rounded border-border"
                          checked={entry.verified}
                          onChange={(event) => {
                            setSize(unit, { verified: event.currentTarget.checked });
                          }}
                        />
                        <span>{t('sellerContainer.verify')}</span>
                      </label>
                    </div>
                  )}
                </fieldset>
              );
            })}
          </div>

          <Field label={t('sellerContainer.notes')} hint={t('preorder.optional')}>
            {({ inputId }) => (
              <Textarea
                id={inputId}
                rows={2}
                maxLength={1000}
                value={draft.notes}
                onChange={(event) => {
                  const notes = event.currentTarget.value;
                  setDraft((current) => ({ ...current, notes }));
                }}
              />
            )}
          </Field>

          {save.isError && (
            <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
              {errorMessage(t, save.error)}
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-ink-muted">{t('sellerContainer.snapshotNote')}</p>
            <Button
              variant="primary"
              disabled={input === null || issues.length > 0 || !previewCurrent || preview.isFetching}
              isLoading={save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              {t('sellerContainer.save')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
