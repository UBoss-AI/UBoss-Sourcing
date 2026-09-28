/**
 * The confirmation every consequential decision on a company application goes
 * through: approve, reject, suspend, ask for more information, ask for
 * re-verification.
 *
 * The confirm button stays disabled until what the decision needs is there -
 * a reason the applicant reads, and for a rejection a reason code - so a
 * decision cannot be made by a stray click. The server refuses the same
 * omissions; this only saves the round trip.
 */
import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { Button, CheckboxField, Field, Select, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { DOCUMENT_KINDS, REJECTION_REASON_CODES } from '@/lib/buyer-companies';

/**
 * One confirmation dialog for every decision. The confirm button stays
 * disabled until everything the server requires is present, so "you must
 * give a reason" is shown as a disabled button with the field beside it
 * rather than as a refusal after pressing it.
 */
export function DecisionDialog({
  title,
  body,
  reasonLabel,
  reasonRequired = false,
  withReasonCode = false,
  withResubmission = false,
  withDocuments = false,
  dangerous = false,
  confirmLabel,
  onClose,
  onConfirm,
  onError,
}: {
  title: string;
  body: string;
  reasonLabel: string;
  reasonRequired?: boolean;
  withReasonCode?: boolean;
  withResubmission?: boolean;
  withDocuments?: boolean;
  dangerous?: boolean;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: (values: { reason: string; reasonCode: string; resubmissionAllowed: boolean; documentKinds: string[] }) => Promise<void>;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [reasonCode, setReasonCode] = useState<string>('');
  const [resubmissionAllowed, setResubmissionAllowed] = useState(true);
  const [documentKinds, setDocumentKinds] = useState<string[]>([]);
  const [working, setWorking] = useState(false);

  const ready = (!reasonRequired || reason.trim().length > 0) && (!withReasonCode || reasonCode !== '');

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={title}
      description={body}
      footer={
        <>
          <Button onClick={onClose} disabled={working}>{t('buyerCompany.cancel')}</Button>
          <Button
            variant={dangerous ? 'danger' : 'primary'}
            disabled={!ready}
            isLoading={working}
            onClick={() => {
              setWorking(true);
              void onConfirm({ reason: reason.trim(), reasonCode, resubmissionAllowed, documentKinds })
                .then(onClose)
                .catch((error: unknown) => {
                  onError(error);
                })
                .finally(() => {
                  setWorking(false);
                });
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {withReasonCode && (
          <Field label={t('buyerCompany.reasonCode')} required>
            {({ inputId, describedBy }) => (
              <Select id={inputId} aria-describedby={describedBy} value={reasonCode} onChange={(event) => { setReasonCode(event.currentTarget.value); }}>
                <option value="">{t('buyerCompany.chooseReason')}</option>
                {REJECTION_REASON_CODES.map((code) => (
                  <option key={code} value={code}>{t(`buyerCompany.rejection.${code}` as TranslationKey)}</option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={reasonLabel} hint={t('buyerCompany.applicantWillRead')} required={reasonRequired}>
          {({ inputId, describedBy }) => (
            <Textarea id={inputId} aria-describedby={describedBy} maxLength={withDocuments ? 5000 : 1000} value={reason} onChange={(event) => { setReason(event.currentTarget.value); }} />
          )}
        </Field>
        {withDocuments && (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-ink">{t('buyerCompany.askForDocuments')}</legend>
            <p className="text-xs text-ink-muted">{t('buyerCompany.askForDocumentsHint')}</p>
            {DOCUMENT_KINDS.map((kind) => (
              <CheckboxField
                key={kind}
                label={t(`buyerCompany.documentKind.${kind}` as TranslationKey)}
                checked={documentKinds.includes(kind)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setDocumentKinds((current) => (checked ? [...current, kind] : current.filter((entry) => entry !== kind)));
                }}
              />
            ))}
          </fieldset>
        )}
        {withResubmission && (
          <CheckboxField
            label={t('buyerCompany.allowResubmission')}
            checked={resubmissionAllowed}
            onChange={(event) => {
              setResubmissionAllowed(event.currentTarget.checked);
            }}
          />
        )}
      </div>
    </Modal>
  );
}
