/**
 * The report: the inspector submits it, the agency's quality reviewer returns
 * or signs it off, and a signed report is corrected only by a new revision
 * that keeps the original, marked as superseded.
 *
 * Two things are said plainly because they are easy to assume wrongly: the
 * result (pass or fail) is worked out by the server from the findings and is
 * never chosen here; and signing off records the reviewer's name - shown as
 * "Signed off by" - which is what it is, and nothing more.
 */
import { useState } from 'react';
import { DownloadButton, EnumBadge, MutationError } from '@/components/console';
import { ConfirmDialog } from '@/components/Modal';
import { Badge, Button, Callout, Card, Field, Textarea } from '@/components/ui';
import { useCurrentUser } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, correctReport, reportPdfPath, returnReport, signReport, submitReport } from '@/lib/console-api';
import type { ExtrasReport, JobReport } from '@/lib/console-types';
import { formatDateTime } from '@/lib/format';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import type { SectionProps } from './types';
import { optional } from './workspace-mode';

interface MergedReport {
  id: string;
  revision: number;
  status: string;
  result: string | null;
  summary: string | null;
  integrity: string | null;
  returnReason: string | null;
  limitations: string | null;
  submittedAt: string | null;
  returnedAt: string | null;
  signedAt: string | null;
  signedByName: string | null;
  correctsReportId: string | null;
  correctionReason: string | null;
  supersededAt: string | null;
}

function mergeReports(primary: JobReport[], extras: ExtrasReport[]): MergedReport[] {
  const ids = new Set([...primary.map((report) => report.id), ...extras.map((report) => report.id)]);
  return [...ids]
    .map((id): MergedReport => {
      const a = primary.find((report) => report.id === id);
      const b = extras.find((report) => report.id === id);
      return {
        id,
        revision: a?.revision ?? b?.revision ?? 0,
        status: a?.status ?? b?.status ?? '',
        result: a?.result ?? b?.result ?? null,
        summary: a?.summary ?? null,
        integrity: a?.integrity ?? null,
        returnReason: a?.returnReason ?? null,
        limitations: b?.limitations ?? null,
        submittedAt: a?.submittedAt ?? null,
        returnedAt: a?.returnedAt ?? null,
        signedAt: a?.signedAt ?? b?.signedAt ?? null,
        signedByName: a?.signedByName ?? b?.signedByName ?? null,
        correctsReportId: b?.correctsReportId ?? null,
        correctionReason: b?.correctionReason ?? null,
        supersededAt: b?.supersededAt ?? null,
      };
    })
    .sort((x, y) => y.revision - x.revision);
}

export function ReportSection({ detail, jobId, mode }: SectionProps): React.JSX.Element {
  const { t } = useI18n();
  const reports = mergeReports(detail.job.reports, detail.extras.reports);
  const status = detail.job.status;
  const latestSigned = reports.find((report) => report.status === 'SIGNED' && report.supersededAt === null);

  return (
    <Card title={t('job.report.title')} description={t('job.report.description')} bodyClassName="px-5 py-4 space-y-5">
      {mode.performing && <SubmitForm jobId={jobId} />}
      {mode.qa && status === 'REPORT_SUBMITTED' && <QaDecision jobId={jobId} />}
      {mode.qa && latestSigned !== undefined && <CorrectForm jobId={jobId} report={latestSigned} />}

      {reports.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('job.report.none')}</p>
      ) : (
        <ol className="space-y-3" aria-label={t('job.report.revisions')}>
          {reports.map((report) => (
            <ReportRow key={report.id} report={report} all={reports} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function ReportRow({ report, all }: { report: MergedReport; all: MergedReport[] }): React.JSX.Element {
  const { t } = useI18n();
  const corrected = report.correctsReportId === null ? undefined : all.find((entry) => entry.id === report.correctsReportId);
  const signed = report.status === 'SIGNED';

  return (
    <li className="rounded-md border border-border px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold text-ink">{t('job.report.revision', { revision: String(report.revision) })}</span>
          <EnumBadge family="reportStatus" value={report.status} />
          {report.result !== null && <EnumBadge family="reportResult" value={report.result} />}
          {signed && report.integrity !== null && <EnumBadge family="integrity" value={report.integrity} />}
          {report.supersededAt !== null && <Badge tone="neutral">{t('job.report.superseded')}</Badge>}
          {report.correctsReportId !== null && <Badge tone="warning">{t('job.report.correction')}</Badge>}
        </div>
        {signed && <DownloadButton path={reportPdfPath(report.id)} fileName={`report-${String(report.revision)}.pdf`} label={t('job.report.pdf')} />}
      </div>
      <div className="mt-2 space-y-1 text-xs text-ink-muted">
        {report.signedAt !== null && (
          <p>{t('job.report.signedOffBy', { name: report.signedByName ?? '—', at: formatDateTime(report.signedAt) })}</p>
        )}
        {report.submittedAt !== null && <p>{t('job.report.submittedAt', { at: formatDateTime(report.submittedAt) })}</p>}
        {report.supersededAt !== null && <p>{t('job.report.supersededAt', { at: formatDateTime(report.supersededAt) })}</p>}
        {report.correctsReportId !== null && (
          <p className="text-ink">
            {t('job.report.correctionOf', {
              revision: corrected === undefined ? '—' : String(corrected.revision),
              reason: report.correctionReason ?? '—',
            })}
          </p>
        )}
      </div>
      {report.returnReason !== null && report.status === 'RETURNED' && (
        <Callout tone="warning" className="mt-2" title={t('job.report.returnedBecause')}>
          {report.returnReason}
        </Callout>
      )}
      {report.summary !== null && (
        <p className="mt-2 text-sm leading-relaxed text-ink">
          <span className="font-medium">{t('job.report.summary')}: </span>
          {report.summary}
        </p>
      )}
      {report.limitations !== null && (
        <p className="mt-1 text-sm leading-relaxed text-ink">
          <span className="font-medium">{t('job.report.limitations')}: </span>
          {report.limitations}
        </p>
      )}
    </li>
  );
}

function SubmitForm({ jobId }: { jobId: string }): React.JSX.Element {
  const { t } = useI18n();
  const [summary, setSummary] = useState('');
  const [limitations, setLimitations] = useState('');
  const submit = useConsoleMutation({
    mutationFn: (_vars, key) => submitReport(jobId, { summary: optional(summary), limitations: optional(limitations) }, key),
    invalidate: [consoleKeys.job(jobId), consoleKeys.jobsAll()],
    successMessage: t('job.report.submitted'),
  });

  return (
    <form
      className="space-y-3 rounded-md border border-border-subtle bg-surface-sunken p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate();
      }}
    >
      <p className="text-sm font-semibold text-ink">{t('job.report.submitTitle')}</p>
      <p className="text-xs leading-relaxed text-ink-muted">{t('job.report.submitHint')}</p>
      <Field label={t('job.report.summary')} hint={t('common.optional')}>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            value={summary}
            maxLength={4000}
            onChange={(event) => {
              setSummary(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label={t('job.report.limitations')} hint={t('job.report.limitationsHint')}>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            value={limitations}
            maxLength={4000}
            onChange={(event) => {
              setLimitations(event.target.value);
            }}
          />
        )}
      </Field>
      <MutationError error={submit.error} />
      <Button type="submit" variant="primary" size="lg" className="w-full sm:w-auto" isLoading={submit.isPending}>
        {t('job.report.submit')}
      </Button>
    </form>
  );
}

function QaDecision({ jobId }: { jobId: string }): React.JSX.Element {
  const { t } = useI18n();
  const me = useCurrentUser();
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const invalidate = [consoleKeys.job(jobId), consoleKeys.jobsAll()];

  const back = useConsoleMutation({
    mutationFn: (_vars, key) => returnReport(jobId, { reason: reason.trim() }, key),
    invalidate,
    successMessage: t('job.report.returned'),
    onSuccess: () => {
      setReason('');
    },
  });
  const sign = useConsoleMutation({
    mutationFn: (_vars, key) => signReport(jobId, key),
    invalidate,
    successMessage: t('job.report.signed'),
    onSuccess: () => {
      setConfirming(false);
    },
  });

  return (
    <div className="grid gap-4 rounded-md border border-border-subtle bg-surface-sunken p-3 lg:grid-cols-2">
      <div className="space-y-2">
        <p className="text-sm font-semibold text-ink">{t('job.report.signTitle')}</p>
        <p className="text-xs leading-relaxed text-ink-muted">{t('job.report.signHint', { name: me.user.fullName })}</p>
        <MutationError error={sign.error} />
        <Button
          variant="primary"
          onClick={() => {
            setConfirming(true);
          }}
        >
          {t('job.report.signOff')}
        </Button>
        <ConfirmDialog
          isOpen={confirming}
          onClose={() => {
            setConfirming(false);
          }}
          onConfirm={() => {
            sign.mutate();
          }}
          isWorking={sign.isPending}
          title={t('job.report.signConfirmTitle')}
          body={t('job.report.signConfirmBody', { name: me.user.fullName })}
          confirmLabel={t('job.report.signOff')}
        />
      </div>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          back.mutate();
        }}
      >
        <p className="text-sm font-semibold text-ink">{t('job.report.returnTitle')}</p>
        <Field label={t('job.report.returnReason')} required>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              value={reason}
              maxLength={2000}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          )}
        </Field>
        <MutationError error={back.error} />
        <Button type="submit" isLoading={back.isPending} disabled={reason.trim() === ''}>
          {t('job.report.return')}
        </Button>
      </form>
    </div>
  );
}

function CorrectForm({ jobId, report }: { jobId: string; report: MergedReport }): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [summary, setSummary] = useState('');
  const [limitations, setLimitations] = useState('');

  const correct = useConsoleMutation({
    mutationFn: (_vars, key) =>
      correctReport(report.id, { reason: reason.trim(), summary: optional(summary), limitations: optional(limitations) }, key),
    invalidate: [consoleKeys.job(jobId), consoleKeys.reports()],
    successMessage: t('job.report.corrected'),
    onSuccess: () => {
      setOpen(false);
      setReason('');
    },
  });

  if (!open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-3 py-2.5">
        <p className="text-xs text-ink-muted">{t('job.report.correctHint', { revision: String(report.revision) })}</p>
        <Button
          size="sm"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('job.report.correct')}
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-3 rounded-md border border-border-subtle bg-surface-sunken p-3"
      onSubmit={(event) => {
        event.preventDefault();
        correct.mutate();
      }}
    >
      <p className="text-sm font-semibold text-ink">{t('job.report.correctTitle', { revision: String(report.revision) })}</p>
      <p className="text-xs leading-relaxed text-ink-muted">{t('job.report.correctExplained')}</p>
      <Field label={t('job.report.correctReason')} required>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            value={reason}
            maxLength={2000}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label={t('job.report.summary')} hint={t('common.optional')}>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            value={summary}
            maxLength={4000}
            onChange={(event) => {
              setSummary(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label={t('job.report.limitations')} hint={t('common.optional')}>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            value={limitations}
            maxLength={4000}
            onChange={(event) => {
              setLimitations(event.target.value);
            }}
          />
        )}
      </Field>
      <MutationError error={correct.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" isLoading={correct.isPending} disabled={reason.trim() === ''}>
          {t('job.report.issueCorrection')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false);
          }}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
