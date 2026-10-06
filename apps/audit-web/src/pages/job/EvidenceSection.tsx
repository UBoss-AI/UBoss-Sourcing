/**
 * Evidence: photographs, videos, documents and measurements, stored
 * privately and hashed by the server.
 *
 * On a phone the file input offers the camera directly. The time the file
 * was taken (its last-modified time) is sent with it, beside the time the
 * server received it, so a photo uploaded later on better signal still says
 * when it was taken. Each file downloads with the session; none is linked.
 */
import { useRef, useState } from 'react';
import { DownloadButton, MutationError } from '@/components/console';
import { Badge, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, evidencePath, uploadEvidence, type EvidenceUploadInput } from '@/lib/console-api';
import { EVIDENCE_PURPOSES, type EvidenceItem } from '@/lib/console-types';
import { enumLabel, enumTone } from '@/lib/enum-labels';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import type { SectionProps } from './types';

/** Purposes an agency uploads for; CAPA and RELEASE come from the seller and the marketplace. */
const AGENCY_PURPOSES = EVIDENCE_PURPOSES.filter((purpose) => purpose !== 'CAPA' && purpose !== 'RELEASE');

export function EvidenceSection({ detail, jobId, mode }: SectionProps): React.JSX.Element {
  const { t } = useI18n();
  const status = detail.job.status;
  const mayUpload =
    (mode.namedInspector && status === 'IN_PROGRESS') ||
    (mode.qa && (status === 'REPORT_SUBMITTED' || status === 'COMPLETED'));
  const evidence = detail.job.evidence;

  return (
    <Card title={t('job.evidence.title')} description={t('job.evidence.description')} bodyClassName="px-5 py-4 space-y-5">
      {mayUpload && <UploadForm detail={detail} jobId={jobId} />}
      {evidence.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('job.evidence.empty')}</p>
      ) : (
        <ul className="divide-y divide-border-subtle rounded-md border border-border" aria-label={t('job.evidence.listLabel')}>
          {evidence.map((item) => (
            <EvidenceRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function EvidenceRow({ item }: { item: EvidenceItem }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="break-all text-sm font-medium text-ink">{item.fileName}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">{enumLabel(t, 'evidencePurpose', item.purpose)}</Badge>
          <Badge tone={enumTone('scanState', item.scanState)} dot>
            {enumLabel(t, 'scanState', item.scanState)}
          </Badge>
          {item.checkItemCode !== null && <span className="font-mono text-xxs text-ink-subtle">{item.checkItemCode}</span>}
        </div>
        <p className="text-xs text-ink-muted">
          {t('job.evidence.meta', {
            who: item.uploadedByLabel ?? item.uploadedByParty,
            received: formatDateTime(item.receivedAt),
            size: formatBytes(item.sizeBytes),
          })}
        </p>
        {item.capturedAt !== null && (
          <p className="text-xs text-ink-muted">{t('job.evidence.captured', { at: formatDateTime(item.capturedAt) })}</p>
        )}
        {item.measurement !== null && <p className="text-xs text-ink">{t('job.evidence.measurementShown', { value: item.measurement })}</p>}
        {item.note !== null && <p className="text-xs text-ink">{item.note}</p>}
        <p className="font-mono text-xxs text-ink-subtle" title={item.contentHash}>
          {t('job.evidence.hash', { hash: item.contentHash.slice(0, 16) })}
        </p>
      </div>
      <div className="shrink-0">
        <DownloadButton path={evidencePath(item.id)} fileName={item.fileName} />
      </div>
    </li>
  );
}

function UploadForm({ detail, jobId }: { detail: SectionProps['detail']; jobId: string }): React.JSX.Element {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [purpose, setPurpose] = useState<string>('GENERAL');
  const [checkItem, setCheckItem] = useState('');
  const [defect, setDefect] = useState('');
  const [measurement, setMeasurement] = useState('');
  const [note, setNote] = useState('');

  const checkCodes = [...new Set([...detail.checklist.map((item) => item.code), ...detail.job.checks.map((check) => check.itemCode)])];

  const upload = useConsoleMutation<EvidenceUploadInput>({
    mutationFn: (input, key) => uploadEvidence(jobId, input, key),
    invalidate: [consoleKeys.job(jobId)],
    successMessage: t('job.evidence.uploaded'),
    onSuccess: () => {
      setFile(null);
      setMeasurement('');
      setNote('');
      if (fileRef.current !== null) fileRef.current.value = '';
    },
  });

  return (
    <form
      className="space-y-3 rounded-md border border-border-subtle bg-surface-sunken p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (file === null) return;
        upload.mutate({
          file,
          purpose,
          checkItemCode: checkItem === '' ? null : checkItem,
          defectId: defect === '' ? null : defect,
          measurement,
          note,
          capturedAt: new Date(file.lastModified).toISOString(),
        });
      }}
    >
      <p className="text-sm font-semibold text-ink">{t('job.evidence.uploadTitle')}</p>
      <Field label={t('job.evidence.file')} required hint={t('job.evidence.fileHint')}>
        {({ inputId, describedBy }) => (
          <input
            ref={fileRef}
            id={inputId}
            aria-describedby={describedBy}
            type="file"
            accept="image/*,video/*,application/pdf"
            capture="environment"
            className="block w-full text-sm text-ink file:mr-3 file:min-h-10 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:text-sm file:font-medium file:text-ink hover:file:bg-surface-hover"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
            }}
          />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('job.evidence.purpose')} required>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={purpose}
              onChange={(event) => {
                setPurpose(event.target.value);
              }}
            >
              {AGENCY_PURPOSES.map((value) => (
                <option key={value} value={value}>
                  {enumLabel(t, 'evidencePurpose', value)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {checkCodes.length > 0 && (
          <Field label={t('job.evidence.checkItem')} hint={t('common.optional')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={checkItem}
                onChange={(event) => {
                  setCheckItem(event.target.value);
                }}
              >
                <option value="">{t('common.none')}</option>
                {checkCodes.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {detail.job.defects.length > 0 && (
          <Field label={t('job.evidence.defect')} hint={t('common.optional')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={defect}
                onChange={(event) => {
                  setDefect(event.target.value);
                }}
              >
                <option value="">{t('common.none')}</option>
                {detail.job.defects.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.ncrNumber} · {enumLabel(t, 'severity', entry.severity)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t('job.evidence.measurement')} hint={t('common.optional')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={measurement}
              maxLength={255}
              onChange={(event) => {
                setMeasurement(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
      <Field label={t('job.evidence.note')} hint={t('common.optional')}>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            value={note}
            maxLength={1000}
            className="min-h-16"
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        )}
      </Field>
      <MutationError error={upload.error} />
      <Button type="submit" variant="primary" isLoading={upload.isPending} disabled={file === null}>
        {t('job.evidence.upload')}
      </Button>
    </form>
  );
}
