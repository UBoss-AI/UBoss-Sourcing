/**
 * Completing a delivery: the proof of delivery, captured from the portal.
 *
 * DELIVERED is reachable only with a proof of delivery, for every shipment -
 * the transition itself refuses otherwise. Before this dialog the portal had
 * no way to supply one, so "delivered" was unreachable from here altogether.
 *
 * What it asks for comes from the server (`shipment.podRequirements`, read
 * from the delivery's SLA policy), and the server checks it all again; the
 * asterisks here are a courtesy, not the rule. Capturing the proof is what
 * marks the shipment delivered - there is no second status step.
 *
 * Files are uploaded first, as the shipment's own documents, and their ids are
 * kept: a retry after a failed capture sends the same ids rather than a second
 * copy of each photograph. The capture itself carries one idempotency key per
 * opening of the dialog, so a double press records one delivery.
 *
 * THE DELIVERY CODE
 *
 * Where the policy asks for one, the person receiving the shipment was emailed
 * a six-digit code when it went out for delivery, and reads it out at the
 * door. The driver types it here. This screen never sees the code itself - it
 * is told only whether one is live, and can ask for a new one to be sent (at
 * most one a minute, five a day), which cancels the last. Where there is
 * nobody to send a code to, it says so and cannot complete the delivery.
 */
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Button, Callout, CheckboxField, Field, Input, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import {
  captureProofOfDelivery,
  documentsKey,
  podKey,
  requestDeliveryCode,
  shipmentKey,
  timelineKey,
  uploadDocument,
} from '@/lib/logistics';
import type { DeliveryCodeState, PodRequirements, ShipmentDetail } from '@/lib/types';

/** The server's own ceiling (document.service.ts), checked here first so nobody waits for a refusal. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** When the server sent nothing (a response cached from before it did): a name, as its default. */
const NAME_ONLY: PodRequirements = {
  requiresRecipientName: true,
  requiresSignature: false,
  requiresPhoto: false,
  requiresOtp: false,
  requiresDesignation: false,
};

type FieldKey = 'recipientName' | 'recipientDesignation' | 'signature' | 'photo' | 'otp';

/** Server detail fields, mapped onto the inputs they are about. */
const SERVER_FIELD: Record<string, FieldKey> = {
  recipientName: 'recipientName',
  recipientDesignation: 'recipientDesignation',
  signatureDocumentId: 'signature',
  photoDocumentId: 'photo',
  otp: 'otp',
};

/** A code the server refused, and what to tell the driver about it. */
const OTP_REFUSAL: Record<string, 'pod.otpWrong' | 'pod.otpDead'> = {
  MISSING: 'pod.otpWrong',
  INVALID: 'pod.otpWrong',
  EXPIRED: 'pod.otpDead',
  NOT_SENT: 'pod.otpDead',
  TOO_MANY_ATTEMPTS: 'pod.otpDead',
};

export function ProofOfDeliveryDialog({
  shipment,
  isOpen,
  onClose,
}: {
  shipment: ShipmentDetail;
  isOpen: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const needs = shipment.podRequirements ?? NAME_ONLY;

  const [recipientName, setRecipientName] = useState('');
  const [designation, setDesignation] = useState('');
  const [signature, setSignature] = useState<File | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [stamped, setStamped] = useState(false);
  const [note, setNote] = useState('');
  const [otp, setOtp] = useState('');
  // The server's word on the code, refreshed by each "send a new code".
  const [codeState, setCodeState] = useState<DeliveryCodeState | null>(shipment.deliveryCode ?? null);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  // Uploaded once per chosen file; a retry reuses the id.
  const uploaded = useRef(new Map<File, string>());

  const fileProblem = (file: File | null, required: boolean): string | undefined => {
    if (file === null) return required ? t('pod.fieldRequired') : undefined;
    if (!file.type.startsWith('image/')) return t('pod.fileNotImage');
    if (file.size > MAX_FILE_BYTES) return t('pod.fileTooLarge');
    return undefined;
  };

  const validate = (): Partial<Record<FieldKey, string>> => {
    const found: Partial<Record<FieldKey, string>> = {};
    // Two characters, as the server counts them, so "." is not a name.
    if (needs.requiresRecipientName && recipientName.trim().length < 2) found.recipientName = t('pod.fieldRequired');
    if (needs.requiresDesignation && designation.trim().length < 2) found.recipientDesignation = t('pod.fieldRequired');
    const signatureProblem = fileProblem(signature, needs.requiresSignature);
    if (signatureProblem !== undefined) found.signature = signatureProblem;
    const photoProblem = fileProblem(photo, needs.requiresPhoto);
    if (photoProblem !== undefined) found.photo = photoProblem;
    if (needs.requiresOtp && !/^\d{6}$/.test(otp.replace(/\s/g, ''))) found.otp = t('pod.otpFormat');
    return found;
  };

  const upload = async (file: File | null, kind: string): Promise<string | undefined> => {
    if (file === null) return undefined;
    const known = uploaded.current.get(file);
    if (known !== undefined) return known;
    const row = await uploadDocument(shipment.id, file, kind);
    uploaded.current.set(file, row.id);
    return row.id;
  };

  const capture = useMutation({
    mutationFn: async () => {
      const signatureDocumentId = await upload(signature, 'DELIVERY_SIGNATURE');
      const photoDocumentId = await upload(photo, 'DELIVERY_PHOTO');
      return captureProofOfDelivery(
        shipment.id,
        {
          ...(recipientName.trim().length > 0 ? { recipientName: recipientName.trim() } : {}),
          ...(designation.trim().length > 0 ? { recipientDesignation: designation.trim() } : {}),
          ...(signatureDocumentId !== undefined ? { signatureDocumentId } : {}),
          ...(photoDocumentId !== undefined ? { photoDocumentId } : {}),
          ...(stamped ? { businessStamped: true } : {}),
          ...(note.trim().length > 0 ? { exceptionNote: note.trim() } : {}),
          ...(needs.requiresOtp ? { otp: otp.replace(/\s/g, '') } : {}),
        },
        idempotencyKey,
      );
    },
    onSuccess: () => {
      toast.success(t('pod.captured'));
      for (const key of [shipmentKey(shipment.id), timelineKey(shipment.id), documentsKey(shipment.id), podKey(shipment.id)]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      onClose();
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.code === 'SHIPMENT_OTP_INVALID') {
        const refusal = error.details.find((detail) => detail.field === 'otp')?.code ?? 'INVALID';
        const key = OTP_REFUSAL[refusal] ?? 'pod.otpWrong';
        setErrors({ otp: t(key) });
        if (key === 'pod.otpDead' && codeState !== null) {
          // Dead on the server: say so here too, so "send a new code" is the obvious next step.
          setCodeState({ ...codeState, status: refusal === 'EXPIRED' ? 'EXPIRED' : 'LOCKED', attemptsLeft: null });
        }
        return;
      }
      if (error instanceof ApiError) {
        const mapped: Partial<Record<FieldKey, string>> = {};
        for (const [field, message] of Object.entries(error.fieldErrors())) {
          const key = SERVER_FIELD[field];
          if (key !== undefined) mapped[key] = message;
        }
        if (Object.keys(mapped).length > 0) {
          setErrors(mapped);
          return;
        }
      }
      toast.error(error.message);
    },
  });

  const resend = useMutation({
    mutationFn: () => requestDeliveryCode(shipment.id),
    onSuccess: (sent) => {
      setCodeState(sent.deliveryCode);
      setOtp('');
      setErrors((current) => {
        const next = { ...current };
        delete next.otp;
        return next;
      });
      toast.success(t('pod.otpSentToast'));
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.code === 'SHIPMENT_OTP_RESEND_LIMITED') {
        toast.error(
          error.details[0]?.code === 'TOO_SOON' ? t('error.SHIPMENT_OTP_RESEND_LIMITED') : t('pod.otpDailyLimit'),
        );
        return;
      }
      if (error instanceof ApiError && error.code === 'SHIPMENT_OTP_UNAVAILABLE') {
        toast.error(t('error.SHIPMENT_OTP_UNAVAILABLE'));
        return;
      }
      toast.error(error.message);
    },
  });

  const submit = (): void => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length === 0) capture.mutate();
  };

  const fileInput = (
    key: 'signature' | 'photo',
    required: boolean,
    choose: (file: File | null) => void,
  ): React.JSX.Element => (
    <Field label={t(key === 'signature' ? 'pod.signature' : 'pod.photo')} required={required} hint={t('pod.fileHint')} error={errors[key]}>
      {({ inputId, describedBy }) => (
        <input
          id={inputId}
          type="file"
          accept="image/*"
          capture="environment"
          aria-describedby={describedBy}
          aria-invalid={errors[key] !== undefined}
          className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:py-2 file:text-sm file:font-medium file:text-accent"
          onChange={(event) => {
            choose(event.target.files?.[0] ?? null);
          }}
        />
      )}
    </Field>
  );

  // A delivery code is checked against one the recipient was sent. With
  // nobody to send one to, a form asking for it could only fail; say so
  // instead. No state at all (an older response) is treated as sendable: the
  // server refuses honestly if it is not.
  const blockedByCode = needs.requiresOtp && codeState?.canBeSent === false;

  const codeStatusLine = (): string => {
    if (codeState === null || codeState.status === 'NOT_SENT') return t('pod.otpNotSent');
    if (codeState.status === 'EXPIRED') return t('pod.otpExpired');
    if (codeState.status === 'LOCKED') return t('pod.otpLocked');
    return t('pod.otpSentAt', { sent: formatDateTime(codeState.sentAt), expires: formatDateTime(codeState.expiresAt) });
  };

  const canResend = codeState === null || (codeState.sendsLeftToday > 0 && codeState.nextSendAt !== null);
  const neverSent = codeState === null || codeState.status === 'NOT_SENT';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('pod.heading')}
      description={t('pod.dialogDescription')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={capture.isPending}>
            {t('modal.cancel')}
          </Button>
          <Button onClick={submit} isLoading={capture.isPending} disabled={blockedByCode}>
            {t('pod.capture')}
          </Button>
        </>
      }
    >
      {blockedByCode ? (
        <Callout tone="warning">{t('pod.otpNoRecipient')}</Callout>
      ) : (
        <div className="space-y-4">
          {needs.requiresOtp ? (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-sm text-ink" role="status">
                {codeStatusLine()}
              </p>
              <Field label={t('pod.otp')} required hint={t('pod.otpHint')} error={errors.otp}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    aria-invalid={errors.otp !== undefined}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={7}
                    value={otp}
                    onChange={(event) => {
                      setOtp(event.target.value);
                    }}
                  />
                )}
              </Field>
              {canResend ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    resend.mutate();
                  }}
                  isLoading={resend.isPending}
                >
                  {neverSent ? t('pod.otpSend') : t('pod.otpResend')}
                </Button>
              ) : (
                <p className="text-xs text-ink-muted">{t('pod.otpDailyLimit')}</p>
              )}
            </div>
          ) : null}

          <Field label={t('pod.recipientName')} required={needs.requiresRecipientName} error={errors.recipientName}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                aria-invalid={errors.recipientName !== undefined}
                maxLength={160}
                autoComplete="off"
                value={recipientName}
                onChange={(event) => {
                  setRecipientName(event.target.value);
                }}
              />
            )}
          </Field>

          <Field label={t('pod.recipientDesignation')} required={needs.requiresDesignation} error={errors.recipientDesignation}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                aria-invalid={errors.recipientDesignation !== undefined}
                maxLength={120}
                autoComplete="off"
                value={designation}
                onChange={(event) => {
                  setDesignation(event.target.value);
                }}
              />
            )}
          </Field>

          {fileInput('signature', needs.requiresSignature, setSignature)}
          {fileInput('photo', needs.requiresPhoto, setPhoto)}

          <CheckboxField
            label={t('pod.businessStamp')}
            checked={stamped}
            onChange={(event) => {
              setStamped(event.target.checked);
            }}
          />

          <Field label={t('pod.exceptionNote')}>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                rows={2}
                maxLength={512}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
      )}
    </Modal>
  );
}
