/**
 * The named inspector, before the work starts: declare any conflict of
 * interest, then start the inspection on site.
 *
 * Start is offered once the declaration says there is none. A declared
 * conflict stops here, with the reason the coordinator needs to reassign.
 */
import { useState } from 'react';
import { MutationError } from '@/components/console';
import { Badge, Button, Callout, Card, Field, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, declareConflict, startJob } from '@/lib/console-api';
import type { AgencyJobDetail } from '@/lib/console-types';
import { formatDateTime } from '@/lib/format';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { cx } from '@/lib/cx';

export function InspectorSection({ detail, jobId }: { detail: AgencyJobDetail; jobId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const status = detail.job.status;
  const mine = detail.conflictCheck.declarations.find((entry) => entry.memberId === detail.me.memberId);
  const [hasConflict, setHasConflict] = useState<boolean | null>(null);
  const [details, setDetails] = useState('');
  const invalidate = [consoleKeys.job(jobId), consoleKeys.jobsAll()];

  const declare = useConsoleMutation({
    mutationFn: (_vars, key) =>
      declareConflict(jobId, { hasConflict: hasConflict === true, details: details.trim() === '' ? null : details.trim() }, key),
    invalidate,
    successMessage: t('job.inspector.declared'),
  });
  const start = useConsoleMutation({
    mutationFn: (_vars, key) => startJob(jobId, key),
    invalidate,
    successMessage: t('job.inspector.started'),
  });

  if (status !== 'INSPECTOR_ASSIGNED') return null;

  const clear = mine !== undefined && !mine.hasConflict;

  return (
    <Card title={t('job.inspector.title')} description={t('job.inspector.description')} bodyClassName="px-5 py-4 space-y-5">
      {mine !== undefined && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
          <Badge tone={mine.hasConflict ? 'danger' : 'success'} dot>
            {mine.hasConflict ? t('job.conflict.declaredConflict') : t('job.conflict.declaredNone')}
          </Badge>
          <span className="text-xs text-ink-muted">{formatDateTime(mine.declaredAt)}</span>
        </p>
      )}
      {mine?.hasConflict === true && (
        <Callout tone="warning" role="status">
          {t('job.inspector.conflictStops')}
        </Callout>
      )}

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          declare.mutate();
        }}
      >
        <fieldset>
          <legend className="text-sm font-medium text-ink">{t('job.inspector.question')}</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {[false, true].map((value) => (
              <label
                key={String(value)}
                className={cx(
                  'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors',
                  hasConflict === value ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-border-strong hover:bg-surface-hover',
                )}
              >
                <input
                  type="radio"
                  name="has-conflict"
                  className="accent-accent"
                  checked={hasConflict === value}
                  onChange={() => {
                    setHasConflict(value);
                  }}
                />
                {value ? t('job.inspector.answerConflict') : t('job.inspector.answerNone')}
              </label>
            ))}
          </div>
        </fieldset>
        {hasConflict === true && (
          <Field label={t('job.inspector.details')} required>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                value={details}
                maxLength={2000}
                onChange={(event) => {
                  setDetails(event.target.value);
                }}
              />
            )}
          </Field>
        )}
        <MutationError error={declare.error} />
        <Button
          type="submit"
          isLoading={declare.isPending}
          disabled={hasConflict === null || (hasConflict && details.trim() === '')}
        >
          {t('job.inspector.declare')}
        </Button>
      </form>

      <div className="space-y-2 border-t border-border-subtle pt-4">
        <p className="text-sm text-ink-muted">{clear ? t('job.inspector.readyToStart') : t('job.inspector.declareFirst')}</p>
        <MutationError error={start.error} />
        <Button
          variant="primary"
          size="lg"
          className="w-full sm:w-auto"
          isLoading={start.isPending}
          disabled={!clear}
          onClick={() => {
            start.mutate();
          }}
        >
          {t('job.inspector.start')}
        </Button>
      </div>
    </Card>
  );
}
