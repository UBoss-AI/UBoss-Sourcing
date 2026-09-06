/**
 * The MDR record for one product.
 *
 * > This screen does not make anything MDR compliant. Regulation (EU) 2017/745
 * > is a quality management system, a clinical evaluation, post-market
 * > surveillance and vigilance reporting — none of which a catalogue holds.
 * > What it holds is the part a buyer and a market surveillance authority read
 * > off the listing, and that is what this panel edits.
 *
 * The interaction worth thinking about is the notified body field, which
 * **appears and becomes required as soon as the chosen class needs one**.
 * That is deliberate teaching: the rule — plain Class I self-certifies, but a
 * sterile, measuring or reusable-surgical Class I does not, and everything
 * from IIa upwards does — is the one a catalogue manager most often gets
 * wrong, and a field materialising in front of them explains it better than a
 * paragraph they will not read.
 *
 * The second is that "is this a device?" has no checkbox. The device record
 * either exists or it does not, and Remove deletes it. A boolean beside the
 * data would be a second thing that could disagree with it.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { ConfirmDialog } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  CheckboxField,
  Field,
  Input,
  LoadingState,
  Select,
  Textarea,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

type DeviceClass =
  | 'CLASS_I'
  | 'CLASS_I_STERILE'
  | 'CLASS_I_MEASURING'
  | 'CLASS_I_REUSABLE_SURGICAL'
  | 'CLASS_IIA'
  | 'CLASS_IIB'
  | 'CLASS_III';

const CLASSES: DeviceClass[] = [
  'CLASS_I',
  'CLASS_I_STERILE',
  'CLASS_I_MEASURING',
  'CLASS_I_REUSABLE_SURGICAL',
  'CLASS_IIA',
  'CLASS_IIB',
  'CLASS_III',
];

/**
 * The one class that self-certifies.
 *
 * Mirrors `requiresNotifiedBody` on the server. Duplicated rather than fetched
 * because the field has to appear the instant the select changes, and a round
 * trip for that would make the form feel broken — the server still enforces
 * it, so the copy here can only ever be optimistic, never authoritative.
 */
function needsNotifiedBody(deviceClass: DeviceClass): boolean {
  return deviceClass !== 'CLASS_I';
}

interface DeviceRecord {
  deviceClass: DeviceClass;
  basicUdiDi: string | null;
  udiDi: string | null;
  notifiedBodyNumber: string | null;
  declarationOfConformityUrl: string | null;
  intendedPurpose: string | null;
  isSterile: boolean;
  isSingleUse: boolean;
  hasMeasuringFunction: boolean;
  containsBiologicalMaterial: boolean;
}

interface Gap {
  field: string;
  code: string;
  message: string;
}

interface Assessment {
  notADevice: boolean;
  compliant: boolean;
  enforced: boolean;
  gaps: Gap[];
  missingPurposeLanguages: string[];
}

interface DeviceResponse {
  assessment: Assessment;
  device: DeviceRecord | null;
}

function emptyDraft(): DeviceRecord {
  return {
    deviceClass: 'CLASS_I',
    basicUdiDi: null,
    udiDi: null,
    notifiedBodyNumber: null,
    declarationOfConformityUrl: null,
    intendedPurpose: null,
    isSterile: false,
    isSingleUse: false,
    hasMeasuringFunction: false,
    containsBiologicalMaterial: false,
  };
}

export function DevicePanel({ productId }: { productId: string }): React.JSX.Element {
  const { t } = useI18n();

  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canWrite = can(Permission.PRODUCT_WRITE);

  const [draft, setDraft] = useState<DeviceRecord>(emptyDraft);
  const [isEditing, setIsEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['product-device', productId],
    queryFn: () => api.get<DeviceResponse>(`/admin/products/${productId}/device`),
  });

  // Follows a reload, so an edit elsewhere on the page does not silently
  // revert here.
  useEffect(() => {
    if (query.data?.device != null) setDraft(query.data.device);
  }, [query.data]);

  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['product-device', productId] }),
      queryClient.invalidateQueries({ queryKey: ['product', productId] }),
    ]);
  };

  const blank = (value: string | null): string | null => {
    const trimmed = (value ?? '').trim();
    return trimmed === '' ? null : trimmed;
  };

  const save = useMutation({
    mutationFn: () =>
      api.put(`/admin/products/${productId}/device`, {
        deviceClass: draft.deviceClass,
        basicUdiDi: blank(draft.basicUdiDi),
        udiDi: blank(draft.udiDi),
        notifiedBodyNumber: blank(draft.notifiedBodyNumber),
        declarationOfConformityUrl: blank(draft.declarationOfConformityUrl),
        intendedPurpose: blank(draft.intendedPurpose),
        isSterile: draft.isSterile,
        isSingleUse: draft.isSingleUse,
        hasMeasuringFunction: draft.hasMeasuringFunction,
        containsBiologicalMaterial: draft.containsBiologicalMaterial,
      }),
    onSuccess: async () => {
      setFormError(null);
      setIsEditing(false);
      toast.success(t('device.saved'));
      await invalidate();
    },
    onError: (error) => {
      setFormError(error instanceof ApiError ? error.message : t('device.couldNotSave'));
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/products/${productId}/device`),
    onSuccess: async () => {
      setConfirmRemove(false);
      setIsEditing(false);
      setDraft(emptyDraft());
      toast.success(t('device.removed'));
      await invalidate();
    },
    onError: (error) => {
      setConfirmRemove(false);
      toast.error(error instanceof ApiError ? error.message : t('device.couldNotRemove'));
    },
  });

  if (query.isPending) {
    return (
      <Card title={t('device.title')}>
        <LoadingState label={t('device.loading')} />
      </Card>
    );
  }

  const assessment = query.data?.assessment;
  const isDevice = query.data?.device != null;

  // Not a device and nobody is marking it as one: one line and a button.
  if (!isDevice && !isEditing) {
    return (
      <Card title={t('device.title')} description={t('device.description')}>
        <div className="space-y-3 px-5 py-4">
          <p className="text-sm text-ink-muted">{t('device.notADevice')}</p>
          {canWrite && (
            <Button
              onClick={() => {
                setDraft(emptyDraft());
                setFormError(null);
                setIsEditing(true);
              }}
            >
              {t('device.markAsDevice')}
            </Button>
          )}
        </div>
      </Card>
    );
  }

  const notifiedBodyRequired = needsNotifiedBody(draft.deviceClass);

  return (
    <>
      <Card title={t('device.title')} description={t('device.description')}>
        <div className="space-y-5 px-5 py-4">
          {/* The scope disclaimer, on the screen rather than only in the docs.
              Somebody filling this in should not come away believing they have
              discharged MDR. */}
          <Callout tone="neutral" title={t('device.scopeTitle')}>
            {t('device.scopeBody')}
          </Callout>

          {assessment !== undefined && !assessment.notADevice && (
            <>
              {assessment.compliant ? (
                <Callout tone="success">{t('device.complete')}</Callout>
              ) : (
                <Callout
                  tone={assessment.enforced ? 'danger' : 'warning'}
                  title={
                    assessment.enforced
                      ? t('device.blocksPublication')
                      : t('device.notEnforcedTitle')
                  }
                >
                  <ul className="list-disc space-y-1 pl-5">
                    {assessment.gaps.map((gap) => (
                      <li key={gap.code}>{gap.message}</li>
                    ))}
                  </ul>
                  {!assessment.enforced && (
                    <p className="mt-2">{t('device.notEnforcedBody')}</p>
                  )}
                </Callout>
              )}

              {assessment.missingPurposeLanguages.length > 0 && (
                <Callout tone="neutral" title={t('device.translationsTitle')}>
                  {t('device.translationsBody', {
                    languages: assessment.missingPurposeLanguages.join(', '),
                  })}
                </Callout>
              )}
            </>
          )}

          {formError !== null && (
            <Callout tone="danger" role="alert">
              {formError}
            </Callout>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('device.class')} hint={t('device.classHint')} required>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  disabled={!canWrite}
                  value={draft.deviceClass}
                  onChange={(event) => {
                    setDraft((current) => ({
                      ...current,
                      deviceClass: event.target.value as DeviceClass,
                    }));
                  }}
                >
                  {CLASSES.map((value) => (
                    <option key={value} value={value}>
                      {t(`device.class.${value}` as 'device.class.CLASS_I')}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            {/* Appears the moment the class needs one. The field materialising
                teaches the rule better than a paragraph would. */}
            {notifiedBodyRequired && (
              <Field
                label={t('device.notifiedBody')}
                hint={t('device.notifiedBodyHint')}
                required
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    className="font-mono sm:w-32"
                    inputMode="numeric"
                    maxLength={8}
                    placeholder="0123"
                    aria-describedby={describedBy}
                    disabled={!canWrite}
                    value={draft.notifiedBodyNumber ?? ''}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        notifiedBodyNumber: event.target.value,
                      }));
                    }}
                  />
                )}
              </Field>
            )}

            <Field label={t('device.udiDi')} hint={t('device.udiDiHint')} required>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  className="font-mono"
                  maxLength={64}
                  aria-describedby={describedBy}
                  disabled={!canWrite}
                  value={draft.udiDi ?? ''}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, udiDi: event.target.value }));
                  }}
                />
              )}
            </Field>

            <Field label={t('device.basicUdiDi')} hint={t('device.basicUdiDiHint')} required>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  className="font-mono"
                  maxLength={64}
                  aria-describedby={describedBy}
                  disabled={!canWrite}
                  value={draft.basicUdiDi ?? ''}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, basicUdiDi: event.target.value }));
                  }}
                />
              )}
            </Field>
          </div>

          <Field label={t('device.intendedPurpose')} hint={t('device.intendedPurposeHint')} required>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                rows={3}
                aria-describedby={describedBy}
                disabled={!canWrite}
                value={draft.intendedPurpose ?? ''}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, intendedPurpose: event.target.value }));
                }}
              />
            )}
          </Field>

          <Field label={t('device.declaration')} hint={t('device.declarationHint')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                type="url"
                placeholder="https://"
                aria-describedby={describedBy}
                disabled={!canWrite}
                value={draft.declarationOfConformityUrl ?? ''}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    declarationOfConformityUrl: event.target.value,
                  }));
                }}
              />
            )}
          </Field>

          <div className="space-y-2 border-t border-border-subtle pt-4">
            <CheckboxField
              disabled={!canWrite}
              checked={draft.isSterile}
              label={t('device.isSterile')}
              description={t('device.isSterileHint')}
              onChange={(event) => {
                setDraft((current) => ({ ...current, isSterile: event.target.checked }));
              }}
            />
            <CheckboxField
              disabled={!canWrite}
              checked={draft.hasMeasuringFunction}
              label={t('device.hasMeasuringFunction')}
              description={t('device.hasMeasuringFunctionHint')}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  hasMeasuringFunction: event.target.checked,
                }));
              }}
            />
            <CheckboxField
              disabled={!canWrite}
              checked={draft.isSingleUse}
              label={t('device.isSingleUse')}
              description={t('device.isSingleUseHint')}
              onChange={(event) => {
                setDraft((current) => ({ ...current, isSingleUse: event.target.checked }));
              }}
            />
            <CheckboxField
              disabled={!canWrite}
              checked={draft.containsBiologicalMaterial}
              label={t('device.containsBiologicalMaterial')}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  containsBiologicalMaterial: event.target.checked,
                }));
              }}
            />
          </div>

          {canWrite && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                isLoading={save.isPending}
                onClick={() => {
                  setFormError(null);
                  save.mutate();
                }}
              >
                {t('device.save')}
              </Button>

              {isDevice && (
                <Button
                  variant="danger"
                  onClick={() => {
                    setConfirmRemove(true);
                  }}
                >
                  {t('device.remove')}
                </Button>
              )}

              {assessment !== undefined && (
                <Badge tone={assessment.enforced ? 'accent' : 'neutral'}>
                  {assessment.enforced ? t('device.enforcedBadge') : t('device.notEnforcedBadge')}
                </Badge>
              )}
            </div>
          )}
        </div>
      </Card>

      <ConfirmDialog
        isOpen={confirmRemove}
        title={t('device.removeTitle')}
        body={t('device.removeBody')}
        confirmLabel={t('device.remove')}
        isDangerous
        isWorking={remove.isPending}
        onClose={() => {
          setConfirmRemove(false);
        }}
        onConfirm={() => {
          remove.mutate();
        }}
      />
    </>
  );
}
