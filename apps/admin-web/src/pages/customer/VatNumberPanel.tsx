/**
 * The customer's EU VAT number, and what VIES made of it.
 *
 * This one field decides whether a cross-border sale is zero-rated, which
 * makes it the highest-consequence text box on the customer screen: get it
 * wrong in one direction and the customer is overcharged 19–27%; wrong in the
 * other and the seller pays that tax out of their own margin.
 *
 * So the panel is built around the **three** states, not two.
 *
 *   - **Confirmed.** VIES answered yes. Only this zero-rates a supply.
 *   - **Refused.** VIES answered no. The number is wrong or cancelled.
 *   - **Not checked.** Nobody has asked, or the member state could not be
 *     reached. Treated exactly like refused for pricing — Art. 138(1)(b) puts
 *     the burden of the customer's status on the seller — but shown
 *     differently, because one is a problem with the number and the other is a
 *     job somebody still has to do.
 *
 * Saving a changed number clears the previous verdict server-side. It has to:
 * carrying an old confirmation onto a new number would zero-rate a supply on
 * the strength of a different company's registration.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, Field, Input } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

export interface VatNumberState {
  vatNumber: string | null;
  /** Null means never checked, which is not the same as false. */
  vatNumberValid: boolean | null;
  vatNumberCheckedAt: string | null;
  /** Art. 31 Reg. 904/2010 evidence that an official answer was relied on. */
  vatNumberReference: string | null;
}

interface CheckResult {
  countryCode: string;
  number: string;
  isValid: boolean | null;
  registeredName: string | null;
  registeredAddress: string | null;
  consultationNumber: string | null;
  unavailableReason: string | null;
  checkedAt: string;
}

function verdictTone(valid: boolean | null): BadgeTone {
  if (valid === true) return 'success';
  if (valid === false) return 'danger';
  return 'warning';
}

export function VatNumberPanel({
  customerId,
  state,
}: {
  customerId: string;
  state: VatNumberState;
}): React.JSX.Element {
  const { t } = useI18n();

  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canWrite = can(Permission.CUSTOMER_WRITE);

  const [value, setValue] = useState(state.vatNumber ?? '');
  const [lastCheck, setLastCheck] = useState<CheckResult | null>(null);

  // Follows a reload from elsewhere on the page, or the box silently reverts
  // an edit somebody just made in another panel.
  useEffect(() => {
    setValue(state.vatNumber ?? '');
  }, [state.vatNumber]);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/admin/customers/${customerId}`, {
        vatNumber: value.trim() === '' ? null : value.trim().toUpperCase(),
      }),
    onSuccess: async () => {
      // The verdict is gone server-side, so the panel must stop showing the
      // old one immediately rather than until the next refetch lands.
      setLastCheck(null);
      toast.success(t('customerVat.saved'));
      await invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t('customerVat.couldNotSave'));
    },
  });

  const check = useMutation({
    mutationFn: () => api.post<CheckResult>(`/admin/customers/${customerId}/vat-number/check`),
    onSuccess: async (result) => {
      setLastCheck(result);

      if (result.isValid === true) toast.success(t('customerVat.confirmed'));
      else if (result.isValid === false) toast.error(t('customerVat.refused'));
      // Not an error: the member state was unreachable, which is ordinary.
      else toast.success(t('customerVat.unavailable'));

      await invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t('customerVat.couldNotCheck'));
    },
  });

  const isDirty = value.trim().toUpperCase() !== (state.vatNumber ?? '');
  const hasNumber = (state.vatNumber ?? '').length > 0;

  return (
    <Card title={t('customerVat.title')} description={t('customerVat.description')}>
      <div className="space-y-4 px-5 py-4">
        <Field label={t('customerVat.number')} hint={t('customerVat.numberHint')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              className="font-mono"
              placeholder="DE811569869"
              maxLength={32}
              aria-describedby={describedBy}
              disabled={!canWrite}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
          )}
        </Field>

        {hasNumber && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={verdictTone(state.vatNumberValid)}>
              {state.vatNumberValid === true
                ? t('customerVat.statusConfirmed')
                : state.vatNumberValid === false
                  ? t('customerVat.statusRefused')
                  : t('customerVat.statusUnchecked')}
            </Badge>

            {state.vatNumberCheckedAt !== null && (
              <span className="text-xxs text-ink-subtle">
                {t('customerVat.checkedAt', {
                  when: formatDateTime(state.vatNumberCheckedAt),
                })}
              </span>
            )}
          </div>
        )}

        {/* The consequence, said plainly. An unverified number looks harmless
            on screen and is the difference between a zero-rated supply and the
            seller paying the tax. */}
        {hasNumber && state.vatNumberValid !== true && (
          <Callout tone="warning">{t('customerVat.notZeroRated')}</Callout>
        )}

        {state.vatNumberReference !== null && (
          <p className="text-xxs text-ink-subtle">
            {t('customerVat.reference', { reference: state.vatNumberReference })}
          </p>
        )}

        {/* What the member state returned. Several answer with "---" as a
            matter of policy, which the API records as null rather than as a
            name - so this block appears only when there is something in it. */}
        {lastCheck !== null &&
          (lastCheck.registeredName !== null || lastCheck.unavailableReason !== null) && (
            <div className="rounded-md bg-surface-sunken px-3 py-2.5 text-xs">
              {lastCheck.registeredName !== null && (
                <p className="text-ink">
                  {t('customerVat.registeredTo', { name: lastCheck.registeredName })}
                </p>
              )}
              {lastCheck.registeredAddress !== null && (
                <p className="mt-0.5 text-ink-muted">{lastCheck.registeredAddress}</p>
              )}
              {lastCheck.unavailableReason !== null && (
                <p className="text-ink-muted">{lastCheck.unavailableReason}</p>
              )}
            </div>
          )}

        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!isDirty}
              isLoading={save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              {t('common.save')}
            </Button>

            <Button
              // Pointless before the number on file matches what is typed:
              // the check runs against what is saved, not against the box.
              disabled={!hasNumber || isDirty}
              isLoading={check.isPending}
              onClick={() => {
                check.mutate();
              }}
            >
              {t('customerVat.checkNow')}
            </Button>
          </div>
        )}

        {isDirty && hasNumber && (
          <p className="text-xxs text-ink-subtle">{t('customerVat.saveBeforeChecking')}</p>
        )}
      </div>
    </Card>
  );
}
