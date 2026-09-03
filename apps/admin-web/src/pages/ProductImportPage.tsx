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
 * A preview can be confirmed once. Double-clicking Confirm is refused by the
 * server, not merely by a disabled button.
 */
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, ErrorState, PageHeader } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
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

function StepHeading({
  step,
  title,
  done,
}: {
  step: number;
  title: string;
  done?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xxs font-bold ${
          done === true ? 'bg-success text-white' : 'bg-accent-soft text-accent'
        }`}
      >
        {done === true ? '✓' : step}
      </span>
      <h2 className="text-sm font-semibold text-ink">
        <span className="sr-only">Step {step}: </span>
        {title}
      </h2>
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
      width: '4rem',
      render: (row) => <span className="tabular font-medium">{row.rowNumber}</span>,
    },
    {
      key: 'field',
      header: 'Column',
      render: (row) => <span className="font-mono text-xxs">{row.field ?? '—'}</span>,
    },
    { key: 'message', header: 'Problem', render: (row) => row.message },
  ];

  const historyColumns: Column<ImportJob>[] = [
    { key: 'file', header: 'File', render: (row) => row.fileName },
    {
      key: 'kind',
      header: 'Kind',
      render: (row) => <Badge>{row.isDryRun ? 'Preview' : 'Import'}</Badge>,
    },
    {
      key: 'status',
      header: 'Result',
      render: (row) => <Badge tone={jobTone(row.status)}>{row.status}</Badge>,
    },
    {
      key: 'rows',
      header: 'Rows',
      align: 'right',
      render: (row) =>
        row.isDryRun
          ? `${formatNumber(row.validRows)} valid / ${formatNumber(row.errorRows)} errors`
          : `${formatNumber(row.createdRows)} new / ${formatNumber(row.updatedRows)} updated`,
    },
    {
      key: 'when',
      header: 'When',
      secondary: true,
      render: (row) => formatDateTime(row.createdAt),
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
        description="Upload a spreadsheet to create and update products. Nothing changes until you confirm."
        actions={
          <Link
            to="/products"
            className="inline-flex h-9 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-sunken"
          >
            Back to products
          </Link>
        }
      />

      <div className="space-y-5">
        {/* --- Step 1 ------------------------------------------------------ */}
        <Card>
          <div className="space-y-3 px-5 py-4">
            <StepHeading step={1} title="Start from the template" />
            <p className="text-sm text-ink-muted">
              CSV only (UTF-8). Every spreadsheet exports it — in Excel, choose{' '}
              <em>Save As → CSV UTF-8</em>. An .xlsx file is refused rather than mis-read.
            </p>

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
              <details className="mt-2">
                <summary className="cursor-pointer text-sm font-medium text-accent">
                  What each column means
                </summary>
                <dl className="mt-2 divide-y divide-border rounded-md border border-border">
                  {columns.data.columns.map((column) => (
                    <div key={column.key} className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2">
                      <dt className="w-40 shrink-0 font-mono text-xs text-ink">
                        {column.key}
                        {column.required && (
                          <span className="ml-1 text-danger" title="Required">
                            *
                          </span>
                        )}
                      </dt>
                      <dd className="flex-1 text-xs text-ink-muted">
                        {column.help}{' '}
                        <span className="text-ink-subtle">e.g. {column.example}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
          </div>
        </Card>

        {/* --- Step 2 ------------------------------------------------------ */}
        <Card>
          <div className="space-y-3 px-5 py-4">
            <StepHeading step={2} title="Upload to preview" done={preview !== null} />
            <p className="text-sm text-ink-muted">
              The upload validates every row and writes nothing. A SKU that already exists is an
              update; a new one is a create. Import never deletes and never publishes.
            </p>

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
              Choose a CSV file
            </Button>

            {uploadError !== null && (
              <p
                role="alert"
                className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
              >
                {uploadError}
              </p>
            )}
          </div>
        </Card>

        {/* --- Preview ----------------------------------------------------- */}
        {preview !== null && (
          <Card
            title={`Preview — ${preview.fileName}`}
            description="Nothing has been written yet."
          >
            <div className="px-5 py-4">
              {hasFatalError ? (
                <p
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
                >
                  {preview.errorMessage}
                </p>
              ) : (
                <>
                  <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      ['Rows read', formatNumber(preview.totalRows)],
                      ['Will create', formatNumber(preview.result?.creates ?? 0)],
                      ['Will update', formatNumber(preview.result?.updates ?? 0)],
                      ['Rows with errors', formatNumber(preview.errorRows)],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="rounded-md border border-border bg-surface-sunken px-3 py-2.5"
                      >
                        <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                          {label}
                        </dt>
                        <dd className="mt-0.5 text-lg font-semibold tabular text-ink">{value}</dd>
                      </div>
                    ))}
                  </dl>

                  {hasRowErrors && (
                    <div className="mt-4">
                      <h3 className="mb-2 text-sm font-semibold text-ink">
                        Rows that will not import
                      </h3>
                      <div className="rounded-md border border-border">
                        <DataTable
                          caption="Row errors"
                          columns={errorColumns}
                          rows={preview.rowErrors}
                          rowKey={(row) => `${String(row.rowNumber)}:${row.field ?? ''}:${row.code}`}
                        />
                      </div>
                      {preview.pagination.truncated && (
                        <p className="mt-2 text-xs text-warning">
                          Only the first {formatNumber(preview.pagination.limit)} errors are listed.
                          With this many, the file's shape is more likely wrong than its rows.
                        </p>
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
            <div className="space-y-3 px-5 py-4">
              <StepHeading step={3} title="Confirm the import" done={applied !== null} />

              {applied === null ? (
                <>
                  <p className="text-sm text-ink-muted">
                    This is the step that changes the catalogue. The file is re-checked first, so
                    anything that changed since the preview is caught here.
                  </p>

                  {hasRowErrors && (
                    <label className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-sm">
                      <input
                        type="checkbox"
                        checked={skipInvalidRows}
                        onChange={(event) => {
                          setSkipInvalidRows(event.target.checked);
                        }}
                        className="mt-0.5 h-4 w-4 rounded border-border-strong text-accent"
                      />
                      <span className="text-ink">
                        Import the {formatNumber(preview.validRows)} valid row
                        {preview.validRows === 1 ? '' : 's'} and skip the{' '}
                        {formatNumber(preview.errorRows)} with errors.
                        <span className="mt-0.5 block text-xs text-ink-muted">
                          Leave this unticked to fix the file and upload it again instead.
                        </span>
                      </span>
                    </label>
                  )}

                  {confirmError !== null && (
                    <p
                      role="alert"
                      className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
                    >
                      {confirmError}
                    </p>
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
                <div className="rounded-md border border-success/30 bg-success-soft px-4 py-3">
                  <p className="text-sm font-medium text-success">
                    Imported {formatNumber(applied.createdRows)} new product
                    {applied.createdRows === 1 ? '' : 's'} and updated{' '}
                    {formatNumber(applied.updatedRows)}.
                  </p>
                  {applied.errorRows > 0 && (
                    <p className="mt-1 text-xs text-ink-muted">
                      {formatNumber(applied.errorRows)} row
                      {applied.errorRows === 1 ? ' was' : 's were'} skipped.
                    </p>
                  )}
                  <p className="mt-2 text-xs text-ink-muted">
                    Imported products are not published. Publish them individually when they are
                    ready for customers.
                  </p>
                  <Link
                    to="/products"
                    className="mt-3 inline-flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium text-white hover:bg-accent-hover"
                  >
                    Review the products
                  </Link>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* --- History ----------------------------------------------------- */}
        <Card title="Recent imports">
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
              emptyTitle="No imports yet"
            />
          )}
        </Card>
      </div>
    </>
  );
}
