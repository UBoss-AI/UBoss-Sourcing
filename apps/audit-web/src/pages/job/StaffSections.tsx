/**
 * What the audit team adds to a job: its timeline, and the partial (sub-lot)
 * releases a supervisor may ask for.
 *
 * A sub-lot request names a clearly identified part of a held lot - its own
 * code, how much, and which order lines it takes - with the reason. It is
 * only a request: somebody else approves it in the Admin Panel.
 */
import { useState } from 'react';
import { EnumBadge, HistoryList, MutationError } from '@/components/console';
import { ConfirmDialog } from '@/components/Modal';
import { Button, Callout, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { cancelSubLotRelease, consoleKeys, requestSubLotRelease } from '@/lib/console-api';
import { QUANTITY_UNITS, type StaffJobDetail, type SubLotRow } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatDateTime, formatQuantity } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { decimalText, wholeNumber } from './workspace-mode';

export function TimelineCard({ detail }: { detail: StaffJobDetail }): React.JSX.Element {
  const { t } = useI18n();
  const entries = detail.timeline.map((event) => ({
    kind: event.kind,
    actorLabel: event.actorLabel,
    summary: event.summary,
    at: event.createdAt ?? '',
  }));
  return (
    <Card title={t('job.timeline.title')} description={t('job.timeline.description')} bodyClassName="px-5 py-4">
      <HistoryList entries={entries} />
    </Card>
  );
}

export function SubLotCard({ detail, jobId }: { detail: StaffJobDetail; jobId: string }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const mayRequest = can(Permission.RELEASE_REQUEST);
  const rows = detail.extras.subLots;

  return (
    <Card title={t('job.subLots.title')} description={t('job.subLots.description')} bodyClassName="px-5 py-4 space-y-5">
      {mayRequest && <SubLotForm detail={detail} jobId={jobId} />}
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('job.subLots.none')}</p>
      ) : (
        <ul className="divide-y divide-border-subtle rounded-md border border-border" aria-label={t('job.subLots.listLabel')}>
          {rows.map((row) => (
            <SubLotItem key={row.id} row={row} jobId={jobId} mayCancel={mayRequest} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function SubLotItem({ row, jobId, mayCancel }: { row: SubLotRow; jobId: string; mayCancel: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const cancel = useConsoleMutation({
    mutationFn: (_vars, key) => cancelSubLotRelease(row.id, key),
    invalidate: [consoleKeys.job(jobId)],
    successMessage: t('job.subLots.cancelled'),
    onSuccess: () => {
      setConfirming(false);
    },
  });

  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-ink">{row.subLotCode}</span>
          <EnumBadge family="subLotState" value={row.state} />
        </div>
        <p className="text-sm tabular text-ink">
          {formatQuantity(row.quantity)} {enumLabel(t, 'unit', row.unit).toLowerCase()}
        </p>
        <p className="text-xs text-ink-muted">
          {t('job.subLots.requestedBy', { name: row.requestedByLabel, at: formatDateTime(row.requestedAt) })}
        </p>
        {row.decidedByLabel !== null && (
          <p className="text-xs text-ink-muted">
            {t('job.subLots.decidedBy', { name: row.decidedByLabel })}
            {row.decisionNote !== null && <> · {row.decisionNote}</>}
          </p>
        )}
        {row.consumedAt !== null && <p className="text-xs text-ink-muted">{t('job.subLots.consumed', { at: formatDateTime(row.consumedAt) })}</p>}
      </div>
      {mayCancel && row.state === 'PENDING_APPROVAL' && (
        <div className="shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t('job.subLots.cancel')}
          </Button>
          <ConfirmDialog
            isOpen={confirming}
            onClose={() => {
              setConfirming(false);
            }}
            onConfirm={() => {
              cancel.mutate();
            }}
            isWorking={cancel.isPending}
            isDangerous
            title={t('job.subLots.cancelTitle', { code: row.subLotCode })}
            body={
              <>
                <p>{t('job.subLots.cancelBody')}</p>
                <div className="mt-2">
                  <MutationError error={cancel.error} />
                </div>
              </>
            }
            confirmLabel={t('job.subLots.cancel')}
          />
        </div>
      )}
    </li>
  );
}

function SubLotForm({ detail, jobId }: { detail: StaffJobDetail; jobId: string }): React.JSX.Element {
  const { t } = useI18n();
  const lines = detail.job.scope?.lines ?? [];
  const [code, setCode] = useState('');
  const [lot, setLot] = useState(detail.job.samplingRecord?.lotReference ?? '');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<string>(detail.extras.quantities?.unit ?? 'PIECE');
  const [perLine, setPerLine] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');

  const chosenLines = lines
    .map((line) => ({ orderItemId: line.orderItemId, quantity: wholeNumber(perLine[line.orderItemId] ?? '') ?? 0 }))
    .filter((line) => line.quantity > 0);
  const lineInvalid = Object.values(perLine).some((value) => value.trim() !== '' && wholeNumber(value) === null);
  const quantityOk = decimalText(quantity) !== null;
  const valid = code.trim() !== '' && lot.trim() !== '' && quantityOk && chosenLines.length > 0 && !lineInvalid && reason.trim().length >= 10;

  const request = useConsoleMutation({
    mutationFn: (_vars, key) =>
      requestSubLotRelease(
        jobId,
        { subLotCode: code.trim(), lotReference: lot.trim(), quantity: quantity.trim(), unit, lines: chosenLines, reason: reason.trim() },
        key,
      ),
    invalidate: [consoleKeys.job(jobId)],
    successMessage: t('job.subLots.requested'),
    onSuccess: () => {
      setCode('');
      setQuantity('');
      setPerLine({});
      setReason('');
    },
  });

  return (
    <form
      className="space-y-3 rounded-md border border-border-subtle bg-surface-sunken p-3"
      onSubmit={(event) => {
        event.preventDefault();
        request.mutate();
      }}
    >
      <p className="text-sm font-semibold text-ink">{t('job.subLots.formTitle')}</p>
      <Callout tone="info">{t('job.subLots.approvedElsewhere')}</Callout>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('job.subLots.code')} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={code}
              maxLength={64}
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t('job.subLots.lot')} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={lot}
              maxLength={64}
              onChange={(event) => {
                setLot(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t('job.subLots.quantity')} required hint={t('job.subLots.quantityHint')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              inputMode="decimal"
              value={quantity}
              invalid={quantity.trim() !== '' && !quantityOk}
              onChange={(event) => {
                setQuantity(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t('job.subLots.unit')} required>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={unit}
              onChange={(event) => {
                setUnit(event.target.value);
              }}
            >
              {QUANTITY_UNITS.map((value) => (
                <option key={value} value={value}>
                  {enumLabel(t, 'unit', value)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">{t('job.subLots.lines')}</legend>
        <p className="text-xs text-ink-muted">{t('job.subLots.linesHint')}</p>
        {lines.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('job.scope.noLines')}</p>
        ) : (
          lines.map((line) => (
            <Field key={line.orderItemId} label={t('job.subLots.lineLabel', { name: line.name, ordered: String(line.quantity) })}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="numeric"
                  className="sm:max-w-40"
                  value={perLine[line.orderItemId] ?? ''}
                  invalid={(perLine[line.orderItemId] ?? '').trim() !== '' && wholeNumber(perLine[line.orderItemId] ?? '') === null}
                  onChange={(event) => {
                    setPerLine((current) => ({ ...current, [line.orderItemId]: event.target.value }));
                  }}
                />
              )}
            </Field>
          ))
        )}
      </fieldset>

      <Field label={t('job.subLots.reason')} required hint={t('common.reasonHint')}>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            value={reason}
            maxLength={4000}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        )}
      </Field>
      <MutationError error={request.error} />
      <Button type="submit" variant="primary" isLoading={request.isPending} disabled={!valid}>
        {t('job.subLots.request')}
      </Button>
    </form>
  );
}
