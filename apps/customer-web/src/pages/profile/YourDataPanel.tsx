/**
 * Your data — the customer's side of GDPR Art. 15, 17 and 20.
 *
 * A right nobody can find is a right nobody has. The obligations behind this
 * panel are usually met with a sentence in a privacy policy saying to email
 * an address; that satisfies a lawyer and almost nobody else, because it puts
 * a stranger's inbox between the person and their own data. Two buttons on the
 * page they already visit is what the regulation is actually reaching for.
 *
 * Three things the design has to get right, none of them obvious:
 *
 *   - **The two rights are not symmetrical, and the page must not pretend they
 *     are.** A copy is instant and harmless; erasure is permanent, may take a
 *     month, and can be lawfully refused. So export is one click, and erasure
 *     is a dialog that says what will actually happen — including that orders
 *     survive, because a customer who expects their invoices to vanish and
 *     later finds them has been misled by this screen.
 *
 *   - **The one-month clock is shown, not hidden.** Art. 12(3) gives the
 *     controller a month, and the deadline is on the row. Somebody chasing a
 *     request should be able to see whether it is late without asking.
 *
 *   - **The download window is short, and says so before it is used.** The
 *     file is every personal fact held about one person. A link that quietly
 *     expires reads as a broken feature unless the page said it would.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Spinner } from '@/components/ui';
import { ApiError, BASE_URL, NetworkError, api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';

interface DataRequest {
  id: string;
  type: 'EXPORT' | 'ERASURE';
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'FAILED';
  requestedAt: string;
  dueAt: string;
  completedAt: string | null;
  decisionNote: string | null;
  downloadToken: string | null;
  downloadExpiresAt: string | null;
}

/**
 * How often to look again while something is in flight.
 *
 * An export usually finishes in under a second, but it is a queued job and the
 * worker may be busy. Polling only while a request is open costs one request
 * every few seconds for a few seconds, and saves the customer wondering
 * whether the page is stuck.
 */
const POLL_MS = 3000;

function statusTone(status: DataRequest['status']): 'neutral' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'COMPLETED':
      return 'success';
    case 'REJECTED':
    case 'FAILED':
      return 'danger';
    case 'IN_PROGRESS':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function YourDataPanel(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [confirmErasure, setConfirmErasure] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['account', 'data-requests'],
    queryFn: () => api.get<{ requests: DataRequest[] }>('/account/data-requests'),
    refetchInterval: (result) => {
      const requests = result.state.data?.requests ?? [];
      const busy = requests.some(
        (request) => request.status === 'PENDING' || request.status === 'IN_PROGRESS',
      );
      return busy ? POLL_MS : false;
    },
  });

  const requests = query.data?.requests ?? [];

  const openExport = requests.find(
    (request) =>
      request.type === 'EXPORT' &&
      (request.status === 'PENDING' || request.status === 'IN_PROGRESS'),
  );

  const openErasure = requests.find(
    (request) =>
      request.type === 'ERASURE' &&
      (request.status === 'PENDING' || request.status === 'IN_PROGRESS'),
  );

  const ready = requests.find(
    (request) => request.type === 'EXPORT' && request.downloadToken !== null,
  );

  const raise = useMutation({
    mutationFn: (type: 'EXPORT' | 'ERASURE') => api.post('/account/data-requests', { type }),
    onSuccess: (_result, type) => {
      setFormError(null);
      setConfirmErasure(false);
      void queryClient.invalidateQueries({ queryKey: ['account', 'data-requests'] });
      toast.success(
        type === 'EXPORT' ? t('yourData.exportStarted') : t('yourData.erasureReceived'),
      );
    },
    onError: (error) => {
      setConfirmErasure(false);
      if (error instanceof NetworkError) {
        setFormError(error.message);
        return;
      }
      setFormError(error instanceof ApiError ? error.message : t('yourData.requestFailed'));
    },
  });

  return (
    <section
      aria-labelledby="your-data-heading"
      className="rounded-lg border border-border bg-surface p-5 shadow-card"
    >
      <h2 id="your-data-heading" className="text-title-sm text-ink">
        {t('yourData.heading')}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">{t('yourData.intro')}</p>

      {formError !== null && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
        >
          {formError}
        </div>
      )}

      {/* The finished file, when there is one. Given its own block rather than
          a link buried in the history table: it is the thing the customer came
          back for, and it stops working in a few days. */}
      {ready?.downloadToken !== null && ready !== undefined && (
        <div className="mt-4 rounded-md border border-success/30 bg-success-soft px-3 py-3 text-sm">
          <p className="font-medium text-ink">{t('yourData.readyHeading')}</p>
          <p className="mt-0.5 text-ink-muted">
            {t('yourData.readyExpires', { when: formatDateTime(ready.downloadExpiresAt) })}
          </p>
          <a
            className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-ink underline underline-offset-2 hover:no-underline"
            href={`${BASE_URL}/my-data/download/${ready.downloadToken}`}
            // The response is an attachment, so this saves rather than
            // navigates; `download` makes that explicit to the browser too.
            download
          >
            {t('yourData.downloadFile')}
          </a>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <Button
          type="button"
          variant="secondary"
          disabled={openExport !== undefined}
          isLoading={raise.isPending && raise.variables === 'EXPORT'}
          onClick={() => { raise.mutate('EXPORT'); }}
        >
          {openExport === undefined ? t('yourData.requestCopy') : t('yourData.copyInProgress')}
        </Button>

        <Button
          type="button"
          variant="danger"
          disabled={openErasure !== undefined}
          onClick={() => {
            setFormError(null);
            setConfirmErasure(true);
          }}
        >
          {openErasure === undefined ? t('yourData.requestErasure') : t('yourData.erasureInProgress')}
        </Button>
      </div>

      <p className="mt-3 text-xs text-ink-muted">{t('yourData.rightsFootnote')}</p>

      {query.isLoading ? (
        <p className="mt-5 flex items-center gap-2 text-sm text-ink-muted">
          <Spinner className="h-4 w-4" />
          {t('common.loading')}
        </p>
      ) : (
        requests.length > 0 && (
          <div className="mt-5 border-t border-border pt-4">
            <h3 className="text-xs uppercase tracking-wider text-ink-subtle">
              {t('yourData.historyHeading')}
            </h3>

            <ul className="mt-3 space-y-3">
              {requests.map((request) => (
                <li key={request.id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">
                      {request.type === 'EXPORT'
                        ? t('yourData.typeExport')
                        : t('yourData.typeErasure')}
                    </span>
                    <Badge tone={statusTone(request.status)}>
                      {t(`yourData.status.${request.status}` as 'yourData.status.PENDING')}
                    </Badge>
                  </div>

                  <p className="mt-0.5 text-xs text-ink-muted">
                    {t('yourData.requestedOn', { when: formatDateTime(request.requestedAt) })}
                    {request.completedAt === null
                      ? // The Art. 12(3) deadline, so a late request is visible
                        // as late rather than merely slow.
                        ` · ${t('yourData.dueBy', { when: formatDateTime(request.dueAt) })}`
                      : ` · ${t('yourData.answeredOn', { when: formatDateTime(request.completedAt) })}`}
                  </p>

                  {request.decisionNote !== null && (
                    <p className="mt-1 rounded-md bg-surface-sunken px-2.5 py-2 text-xs text-ink">
                      {request.decisionNote}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      )}

      <Modal
        isOpen={confirmErasure}
        onClose={() => { setConfirmErasure(false); }}
        title={t('yourData.confirmTitle')}
        description={t('yourData.confirmDescription')}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => { setConfirmErasure(false); }}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              isLoading={raise.isPending}
              onClick={() => { raise.mutate('ERASURE'); }}
            >
              {t('yourData.confirmSubmit')}
            </Button>
          </>
        }
      >
        {/* Said plainly and before the fact. A customer who expects their
            invoices to disappear and later finds them has been misled by this
            dialog, not by the law. */}
        <ul className="list-disc space-y-2 pl-5 text-sm text-ink-muted">
          <li>{t('yourData.confirmPointAccount')}</li>
          <li>{t('yourData.confirmPointOrders')}</li>
          <li>{t('yourData.confirmPointReview')}</li>
          <li>{t('yourData.confirmPointExportFirst')}</li>
        </ul>
      </Modal>
    </section>
  );
}
