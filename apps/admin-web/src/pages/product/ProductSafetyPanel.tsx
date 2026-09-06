/**
 * Product safety — GPSR Art. 19.
 *
 * The panel is built around a checklist rather than a form, because the
 * failure it exists to prevent is not a typo — it is a product going live
 * without information the regulation says a buyer must see before they buy.
 * So the gaps are listed at the top, in the same words the publish button will
 * use, and they are drawn from the same server-side assessment: what the
 * screen shows and what publication enforces cannot drift, because they are
 * the same function.
 *
 * Two details worth keeping.
 *
 * **The gaps are shown whether or not enforcement is on.** A deployment that
 * has not switched `gpsrEnforced` on still sees exactly what switching it on
 * would cost, which is the only way to plan the work rather than discover it
 * when the catalogue stops publishing.
 *
 * **Missing translations are reported separately and never block.** Art. 19(d)
 * wants the warning in a language the reader understands, so a warning that
 * exists only in the base language is a real gap — but refusing to publish
 * until eight translations are done would stop a catalogue going live at all.
 * It is a job for the translations tab, not a blocker here.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Input,
  LoadingState,
  Select,
  Textarea,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

interface Gap {
  field: string;
  code: string;
  message: string;
}

interface Assessment {
  compliant: boolean;
  /** Whether these gaps currently block publication. */
  enforced: boolean;
  gaps: Gap[];
  missingWarningLanguages: string[];
}

interface Operator {
  id: string;
  role: 'MANUFACTURER' | 'EU_RESPONSIBLE_PERSON' | 'IMPORTER';
  legalName: string;
  countryCode: string;
}

export interface ProductSafetyValues {
  manufacturerId: string | null;
  euResponsibleId: string | null;
  gtin: string | null;
  modelIdentifier: string | null;
  safetyWarnings: string | null;
  safetyInstructions: string | null;
}

export function ProductSafetyPanel({
  productId,
  values,
}: {
  productId: string;
  values: ProductSafetyValues;
}): React.JSX.Element {
  const { t } = useI18n();

  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canWrite = can(Permission.PRODUCT_WRITE);

  const [draft, setDraft] = useState({
    manufacturerId: values.manufacturerId ?? '',
    euResponsibleId: values.euResponsibleId ?? '',
    gtin: values.gtin ?? '',
    modelIdentifier: values.modelIdentifier ?? '',
    safetyWarnings: values.safetyWarnings ?? '',
    safetyInstructions: values.safetyInstructions ?? '',
  });
  const [formError, setFormError] = useState<string | null>(null);

  // The product reloads after a save elsewhere on the page; the draft has to
  // follow, or an edit here silently reverts what somebody just changed.
  useEffect(() => {
    setDraft({
      manufacturerId: values.manufacturerId ?? '',
      euResponsibleId: values.euResponsibleId ?? '',
      gtin: values.gtin ?? '',
      modelIdentifier: values.modelIdentifier ?? '',
      safetyWarnings: values.safetyWarnings ?? '',
      safetyInstructions: values.safetyInstructions ?? '',
    });
  }, [values]);

  const assessment = useQuery({
    queryKey: ['product-safety', productId],
    queryFn: () => api.get<Assessment>(`/admin/products/${productId}/safety`),
  });

  const operators = useQuery({
    queryKey: ['economic-operators', ''],
    queryFn: () => api.get<{ operators: Operator[] }>('/admin/economic-operators'),
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/admin/products/${productId}`, {
        manufacturerId: draft.manufacturerId === '' ? null : draft.manufacturerId,
        euResponsibleId: draft.euResponsibleId === '' ? null : draft.euResponsibleId,
        gtin: draft.gtin.trim() === '' ? null : draft.gtin.trim(),
        modelIdentifier:
          draft.modelIdentifier.trim() === '' ? null : draft.modelIdentifier.trim(),
        safetyWarnings: draft.safetyWarnings.trim() === '' ? null : draft.safetyWarnings,
        safetyInstructions:
          draft.safetyInstructions.trim() === '' ? null : draft.safetyInstructions,
      }),
    onSuccess: async () => {
      setFormError(null);
      toast.success(t('productSafety.saved'));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['product', productId] }),
        // Re-run the checklist against what was just saved, or the panel keeps
        // showing gaps the operator has already closed.
        queryClient.invalidateQueries({ queryKey: ['product-safety', productId] }),
      ]);
    },
    onError: (error) => {
      setFormError(error instanceof ApiError ? error.message : t('productSafety.couldNotSave'));
    },
  });

  const manufacturers = (operators.data?.operators ?? []).filter(
    (operator) => operator.role !== 'EU_RESPONSIBLE_PERSON',
  );

  const representatives = (operators.data?.operators ?? []).filter(
    (operator) => operator.role === 'EU_RESPONSIBLE_PERSON',
  );

  const result = assessment.data;

  return (
    <Card title={t('productSafety.title')} description={t('productSafety.description')}>
      <div className="space-y-5 px-5 py-4">
        {assessment.isPending ? (
          <LoadingState label={t('productSafety.checking')} />
        ) : (
          result !== undefined && (
            <>
              {result.compliant ? (
                <Callout tone="success">{t('productSafety.complete')}</Callout>
              ) : (
                <Callout
                  tone={result.enforced ? 'danger' : 'warning'}
                  title={
                    result.enforced
                      ? t('productSafety.blocksPublication')
                      : t('productSafety.notEnforcedTitle')
                  }
                >
                  <ul className="list-disc space-y-1 pl-5">
                    {result.gaps.map((gap) => (
                      <li key={gap.code}>{gap.message}</li>
                    ))}
                  </ul>
                  {!result.enforced && (
                    <p className="mt-2">{t('productSafety.notEnforcedBody')}</p>
                  )}
                </Callout>
              )}

              {result.missingWarningLanguages.length > 0 && (
                <Callout tone="neutral" title={t('productSafety.translationsTitle')}>
                  {t('productSafety.translationsBody', {
                    languages: result.missingWarningLanguages.join(', '),
                  })}
                </Callout>
              )}
            </>
          )
        )}

        {formError !== null && (
          <Callout tone="danger" role="alert">
            {formError}
          </Callout>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('productSafety.manufacturer')} hint={t('productSafety.manufacturerHint')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                disabled={!canWrite}
                value={draft.manufacturerId}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, manufacturerId: event.target.value }));
                }}
              >
                <option value="">{t('productSafety.none')}</option>
                {manufacturers.map((operator) => (
                  <option key={operator.id} value={operator.id}>
                    {operator.legalName} ({operator.countryCode})
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label={t('productSafety.euResponsible')}
            hint={t('productSafety.euResponsibleHint')}
          >
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                disabled={!canWrite}
                value={draft.euResponsibleId}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, euResponsibleId: event.target.value }));
                }}
              >
                <option value="">{t('productSafety.none')}</option>
                {representatives.map((operator) => (
                  <option key={operator.id} value={operator.id}>
                    {operator.legalName} ({operator.countryCode})
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label={t('productSafety.model')} hint={t('productSafety.modelHint')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                maxLength={64}
                aria-describedby={describedBy}
                disabled={!canWrite}
                value={draft.modelIdentifier}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, modelIdentifier: event.target.value }));
                }}
              />
            )}
          </Field>

          <Field label={t('productSafety.gtin')} hint={t('productSafety.gtinHint')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                className="font-mono"
                inputMode="numeric"
                maxLength={14}
                aria-describedby={describedBy}
                disabled={!canWrite}
                value={draft.gtin}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, gtin: event.target.value }));
                }}
              />
            )}
          </Field>
        </div>

        <Field label={t('productSafety.warnings')} hint={t('productSafety.warningsHint')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              rows={4}
              aria-describedby={describedBy}
              disabled={!canWrite}
              value={draft.safetyWarnings}
              onChange={(event) => {
                setDraft((current) => ({ ...current, safetyWarnings: event.target.value }));
              }}
            />
          )}
        </Field>

        <Field label={t('productSafety.instructions')} hint={t('productSafety.instructionsHint')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              rows={3}
              aria-describedby={describedBy}
              disabled={!canWrite}
              value={draft.safetyInstructions}
              onChange={(event) => {
                setDraft((current) => ({ ...current, safetyInstructions: event.target.value }));
              }}
            />
          )}
        </Field>

        {canWrite && (
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              isLoading={save.isPending}
              onClick={() => {
                setFormError(null);
                save.mutate();
              }}
            >
              {t('productSafety.save')}
            </Button>

            {result !== undefined && (
              <Badge tone={result.enforced ? 'accent' : 'neutral'}>
                {result.enforced
                  ? t('productSafety.enforcedBadge')
                  : t('productSafety.notEnforcedBadge')}
              </Badge>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
