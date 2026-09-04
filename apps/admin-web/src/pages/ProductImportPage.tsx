/**
 * Bulk product import.
 *
 * A three-step flow, and the steps are not decorative — they are what the
 * backend enforces:
 *
 *   1. **Download the template.** The column contract comes from the server
 *      (`/products/import/columns`), so this page never restates the rules and
 *      cannot drift from them.
 *   2. **Upload to preview.** The upload writes nothing. It returns a preview
 *      job with per-row errors, numbered the way a spreadsheet numbers rows.
 *   3. **Confirm.** Only this changes the catalogue. A file with any row error
 *      imports nothing unless "skip invalid rows" is ticked deliberately, and
 *      the server re-validates the file at this point — so a preview taken
 *      before someone else archived a category is caught here rather than
 *      applied blindly.
 *
 * Steps two and three appear only once the step before them is done, so the
 * page is never showing a control that cannot yet do anything.
 *
 * A preview can be confirmed once. Double-clicking Confirm is refused by the
 * server, not merely by a disabled button.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  CheckboxField,
  ErrorState,
  LinkButton,
  PageHeader,
  SummaryTiles,
} from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { cx } from '@/lib/cx';
import { ApiError, api, downloadFile } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import type { ImportJob, ImportRowError } from '@/lib/types';

interface ColumnSpec {
  key: string;
  required: boolean;
  help: string;
  example: string;
}

function jobTone(status: ImportJob['status']): BadgeTone {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'PARTIAL') return 'warning';
  if (status === 'FAILED' || status === 'DEAD') return 'danger';
  return 'neutral';
}

/**
 * One step of the wizard.
 *
 * The number is the whole of the affordance — a numbered circle that fills in
 * green when the step is behind you. No progress bar, because three steps do
 * not need one and a bar would imply a percentage nothing here can honestly
 * report.
 */
function StepHeading({
  step,
  title,
  description,
  done,
}: {
  step: number;
  title: string;
  description?: string;
  done?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex gap-3">
      <span
        aria-hidden="true"
        className={cx(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
          done === true ? 'bg-success text-white' : 'bg-accent-soft text-accent',
        )}
      >
        {done === true ? '✓' : step}
      </span>
      <div className="min-w-0">
        <h2 className="text-title-xs text-ink">
          <span className="sr-only">Step {step}: </span>
          {title}
        </h2>
        {description !== undefined && (
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-muted">{description}</p>
        )}
      </div>
    </div>
  );
}

export function ProductImportPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<ImportJob | null>(null);
  const [applied, setApplied] = useState<ImportJob | null>(null);
  const [skipInvalidRows, setSkipInvalidRows] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const columns = useQuery({
    queryKey: ['import-columns'],
    queryFn: () => api.get<{ columns: ColumnSpec[] }>('/admin/products/import/columns'),
  });

  const history = useQuery({
    queryKey: ['import-jobs'],
    queryFn: () => api.get<{ jobs: ImportJob[] }>('/admin/products/import', { query: { limit: 10 } }),
  });

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.upload<ImportJob>('/admin/products/import', form);
    },
    onSuccess: async (job) => {
      setUploadError(null);
      setConfirmError(null);
      setApplied(null);
      setSkipInvalidRows(false);
      setPreview(job);
      await queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
    },
    onError: (error) => {
      setPreview(null);
      setUploadError(error instanceof ApiError ? error.message : 'The file could not be read.');
    },
  });

  const confirm = useMutation({
    mutationFn: (job: ImportJob) =>
      api.post<ImportJob>(`/admin/products/import/${job.id}/confirm`, { skipInvalidRows }),
    onSuccess: async (job) => {
      setConfirmError(null);
      setApplied(job);
      toast.success(
        `Imported: ${formatNumber(job.createdRows)} created, ${formatNumber(job.updatedRows)} updated.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      await queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
    },
    onError: (error) => {
      setConfirmError(error instanceof ApiError ? error.message : 'The import could not be applied.');
    },
  });

  const errorColumns: Column<ImportRowError>[] = [
    {
      key: 'row',
      header: 'Row',
      align: 'right',
      width: '5rem',
      render: (row) => <span className="font-medium">{row.rowNumber}</span>,
    },
    {
      key: 'field',
      header: 'Column',
      nowrap: true,
      render: (row) => <span className="font-mono text-xxs">{row.field ?? '—'}</span>,
    },
    { key: 'message', header: 'Problem', render: (row) => row.message },
  ];

  const historyColumns: Column<ImportJob>[] = [
    {
      key: 'file',
      header: 'File',
      render: (row) => <span className="font-mono text-xs text-ink">{row.fileName}</span>,
    },
    {
      key: 'kind',
      header: 'Kind',
      render: (row) => <Badge>{row.isDryRun ? 'Preview' : 'Import'}</Badge>,
    },
    {
      key: 'status',
      header: 'Result',
      render: (row) => (
        <Badge dot tone={jobTone(row.status)}>
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'rows',
      header: 'Rows',
      align: 'right',
      nowrap: true,
      render: (row) =>
        row.isDryRun
          ? `${formatNumber(row.validRows)} valid / ${formatNumber(row.errorRows)} errors`
          : `${formatNumber(row.createdRows)} new / ${formatNumber(row.updatedRows)} updated`,
    },
    {
      key: 'when',
      header: 'When',
      secondary: true,
      nowrap: true,
      render: (row) => <span className="text-ink-muted">{formatDateTime(row.createdAt)}</span>,
    },
  ];

  const hasFatalError = preview !== null && preview.errorMessage !== null;
  const hasRowErrors = preview !== null && preview.errorRows > 0;
  const canConfirm =
    preview !== null && !hasFatalError && preview.validRows > 0 && (!hasRowErrors || skipInvalidRows);

  return (
    <>
      <PageHeader
        title="Bulk product import"
        back={{ to: '/products', label: 'Back to products' }}
        description="Upload a spreadsheet to create and update products. Nothing changes until you confirm — and import never deletes and never publishes."
      />

      <div className="space-y-5">
        {/* --- Step 1 ------------------------------------------------------ */}
        <Card>
          <div className="space-y-4 px-5 py-4">
            <StepHeading
              step={1}
              title="Start from the template"
              description="CSV only (UTF-8). Every spreadsheet exports it — in Excel, choose Save As → CSV UTF-8. An .xlsx file is refused rather than mis-read."
            />

            <div className="pl-10">
              <Button
                onClick={() => {
                  void downloadFile(
                    '/admin/products/import/template',
                    'uboss-product-import-template.csv',
                  ).catch(() => {
                    toast.error('The template could not be downloaded.');
                  });
                }}
              >
                Download the CSV template
              </Button>

              {columns.data !== undefined && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium text-accent hover:underline">
                    What each column means
                  </summary>
                  <dl className="mt-2 divide-y divide-border-subtle overflow-hidden rounded-md border border-border">
                    {columns.data.columns.map((column) => (
                      <div key={column.key} className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2">
                        <dt className="w-40 shrink-0 font-mono text-xs text-ink">
                          {column.key}
                          {column.required && (
                            <>
                              <span className="ml-1 text-danger" aria-hidden="true">
                                *
                              </span>
                              <span className="sr-only"> (required)</span>
                            </>
                          )}
                        </dt>
                        <dd className="flex-1 text-xs leading-relaxed text-ink-muted">
                          {column.help}{' '}
                          <span className="text-ink-subtle">e.g. {column.example}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </div>
          </div>
        </Card>

        {/* --- Step 2 ------------------------------------------------------ */}
        <Card>
          <div className="space-y-4 px-5 py-4">
            <StepHeading
              step={2}
              title="Upload to preview"
              done={preview !== null}
              description="The upload validates every row and writes nothing. A SKU that already exists is an update; a new one is a create."
            />

            <div className="space-y-3 pl-10">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) upload.mutate(file);
                  event.target.value = '';
                }}
              />
              <Button
                variant="primary"
                isLoading={upload.isPending}
                onClick={() => {
                  fileRef.current?.click();
                }}
              >
                {preview === null ? 'Choose a CSV file' : 'Choose a different file'}
              </Button>

              {uploadError !== null && (
                <Callout tone="danger" role="alert">
                  {uploadError}
                </Callout>
              )}
            </div>
          </div>
        </Card>

        {/* --- Preview ----------------------------------------------------- */}
        {preview !== null && (
          <Card
            title={`Preview — ${preview.fileName}`}
            description="Nothing has been written yet."
            tone={hasFatalError ? 'danger' : 'default'}
          >
            <div className="px-5 py-4">
              {hasFatalError ? (
                <Callout tone="danger" role="alert" title="The file could not be read">
                  {preview.errorMessage}
                </Callout>
              ) : (
                <>
                  <SummaryTiles
                    items={[
                      { label: 'Rows read', value: formatNumber(preview.totalRows) },
                      {
                        label: 'Will create',
                        value: formatNumber(preview.result?.creates ?? 0),
                        tone: 'success',
                      },
                      { label: 'Will update', value: formatNumber(preview.result?.updates ?? 0) },
                      {
                        label: 'Rows with errors',
                        value: formatNumber(preview.errorRows),
                        tone: preview.errorRows > 0 ? 'danger' : 'default',
                      },
                    ]}
                  />

                  {hasRowErrors && (
                    <div className="mt-4">
                      <h3 className="mb-2 text-title-xs text-ink">Rows that will not import</h3>
                      <div className="overflow-hidden rounded-md border border-border">
                        <DataTable
                          caption="Row errors"
                          columns={errorColumns}
                          rows={preview.rowErrors}
                          rowKey={(row) => `${String(row.rowNumber)}:${row.field ?? ''}:${row.code}`}
                          minWidth="34rem"
                        />
                      </div>
                      {preview.pagination.truncated && (
                        <Callout tone="warning" className="mt-2">
                          Only the first {formatNumber(preview.pagination.limit)} errors are listed.
                          With this many, the file&rsquo;s shape is more likely wrong than its rows.
                        </Callout>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>
        )}

        {/* --- Step 3 ------------------------------------------------------ */}
        {preview !== null && !hasFatalError && (
          <Card>
            <div className="space-y-4 px-5 py-4">
              <StepHeading
                step={3}
                title="Confirm the import"
                done={applied !== null}
                {...(applied === null
                  ? {
                      description:
                        'This is the step that changes the catalogue. The file is re-checked first, so anything that changed since the preview is caught here.',
                    }
                  : {})}
              />

              <div className="space-y-3 pl-10">
                {applied === null ? (
                  <>
                    {hasRowErrors && (
                      <CheckboxField
                        boxed
                        tone="warning"
                        checked={skipInvalidRows}
                        onChange={(event) => {
                          setSkipInvalidRows(event.target.checked);
                        }}
                        label={`Import the ${formatNumber(preview.validRows)} valid row${preview.validRows === 1 ? '' : 's'} and skip the ${formatNumber(preview.errorRows)} with errors.`}
                        description="Leave this unticked to fix the file and upload it again instead — which is usually the right answer."
                      />
                    )}

                    {confirmError !== null && (
                      <Callout tone="danger" role="alert">
                        {confirmError}
                      </Callout>
                    )}

                    <Button
                      variant="primary"
                      disabled={!canConfirm}
                      isLoading={confirm.isPending}
                      onClick={() => {
                        confirm.mutate(preview);
                      }}
                    >
                      {hasRowErrors && skipInvalidRows
                        ? `Import ${formatNumber(preview.validRows)} valid rows`
                        : `Import ${formatNumber(preview.validRows)} rows`}
                    </Button>

                    {preview.validRows === 0 && (
                      <p className="text-xs text-ink-muted">
                        There is nothing to import — every row has an error.
                      </p>
                    )}
                  </>
                ) : (
                  <Callout
                    tone="success"
                    role="status"
                    title={`Imported ${formatNumber(applied.createdRows)} new product${applied.createdRows === 1 ? '' : 's'} and updated ${formatNumber(applied.updatedRows)}.`}
                  >
                    <div className="space-y-2">
                      {applied.errorRows > 0 && (
                        <p>
                          {formatNumber(applied.errorRows)} row
                          {applied.errorRows === 1 ? ' was' : 's were'} skipped.
                        </p>
                      )}
                      <p>
                        Imported products are not published. Publish them individually when they are
                        ready for customers.
                      </p>
                      <LinkButton to="/products" size="sm" variant="primary">
                        Review the products
                      </LinkButton>
                    </div>
                  </Callout>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* --- History ----------------------------------------------------- */}
        <Card title="Recent imports" description="The last ten, previews included.">
          {history.isError ? (
            <ErrorState
              error={history.error}
              onRetry={() => {
                void history.refetch();
              }}
            />
          ) : (
            <DataTable
              caption="Recent imports"
              columns={historyColumns}
              rows={history.data?.jobs}
              rowKey={(row) => row.id}
              isLoading={history.isPending}
              loadingLabel="Loading recent imports"
              minWidth="48rem"
              emptyTitle="No imports yet"
              emptyDescription="Uploads and confirmed imports both appear here."
            />
          )}
        </Card>
      </div>
    </>
  );
}
