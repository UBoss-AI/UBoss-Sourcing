/**
 * The files a customer sent in with a ticket, and a viewer to check them.
 *
 * Reviewing what somebody uploaded - a photograph of a damaged box, a scanned
 * invoice, a short video - is the reason most of these tickets exist, so the
 * files sit in the main column beside the conversation rather than in a
 * narrow list at the side. "Open" used to send the whole tab to the file and
 * away from the ticket being answered; now nothing leaves the page.
 *
 *   - An image is previewed here, in a dialog, at fit-to-screen or actual
 *     size, and the arrows step through the others on the ticket.
 *   - A PDF or a video is downloaded, again without leaving the page. The
 *     console's security policy lets a page show a `blob:` image but not frame
 *     a document or play a `blob:` video, and that policy is not loosened for
 *     files strangers upload.
 *
 * Nothing is fetched until somebody asks: every file opened is recorded in the
 * audit log, and a thumbnail loaded on its own would be a record of looking
 * that nobody did. Once fetched, a file is kept for as long as the ticket is
 * open on screen, so stepping back to it or downloading it after a preview
 * does not open - and record - it a second time.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/Modal';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DocumentFileIcon,
  DownloadIcon,
  EyeIcon,
  ImageFileIcon,
  VideoFileIcon,
} from '@/components/icons';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { fetchTicketAttachment, formatFileSize, saveBlob } from '@/lib/support-tickets';
import type { AdminTicket } from '@/lib/support-tickets';

type Attachment = AdminTicket['attachments'][number];

/** The short type label on a file's tile: PDF, JPG, MP4. */
function extensionOf(file: Attachment): string {
  const fromName = /\.([A-Za-z0-9]{2,5})$/.exec(file.fileName)?.[1];
  if (fromName !== undefined) return fromName.toUpperCase();
  return (file.contentType.split('/')[1] ?? '').toUpperCase();
}

/** Only raster images the server sniffed from the bytes are shown in the page. */
function isPreviewable(file: Attachment): boolean {
  return file.kind === 'IMAGE' && file.contentType.startsWith('image/') && file.contentType !== 'image/svg+xml';
}

const KIND_STYLE: Record<Attachment['kind'], { icon: typeof DocumentFileIcon; plate: string }> = {
  IMAGE: { icon: ImageFileIcon, plate: 'bg-accent-soft text-accent ring-accent/20' },
  VIDEO: { icon: VideoFileIcon, plate: 'bg-operational-soft text-operational ring-operational/20' },
  DOCUMENT: { icon: DocumentFileIcon, plate: 'bg-danger-soft text-danger ring-danger/20' },
};

/**
 * Files fetched so far on this ticket, by attachment id, as blob URLs.
 *
 * Revoked when the ticket leaves the screen, so an image a person looked at is
 * not kept in memory behind the next page.
 */
function useFetchedFiles(ticketId: string): {
  get: (file: Attachment) => Promise<{ blob: Blob; url: string }>;
} {
  const cache = useRef(new Map<string, Promise<{ blob: Blob; url: string }>>());

  useEffect(() => {
    const held = cache.current;
    return () => {
      for (const pending of held.values()) {
        void pending.then(({ url }) => {
          URL.revokeObjectURL(url);
        }).catch(() => undefined);
      }
      held.clear();
    };
  }, [ticketId]);

  const get = useCallback(
    (file: Attachment) => {
      const existing = cache.current.get(file.id);
      if (existing !== undefined) return existing;

      const pending = fetchTicketAttachment(ticketId, file.id).then((blob) => ({
        blob,
        url: URL.createObjectURL(blob),
      }));
      // A failed fetch is forgotten, so "Try again" asks the server again.
      pending.catch(() => {
        cache.current.delete(file.id);
      });
      cache.current.set(file.id, pending);
      return pending;
    },
    [ticketId],
  );

  return { get };
}

export function TicketDocuments({ ticket }: { ticket: AdminTicket }): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const files = useFetchedFiles(ticket.id);
  const [viewing, setViewing] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const previewable = useMemo(() => ticket.attachments.filter(isPreviewable), [ticket.attachments]);

  const download = async (file: Attachment): Promise<void> => {
    setDownloading(file.id);
    try {
      const { blob } = await files.get(file);
      saveBlob(blob, file.fileName);
    } catch (error) {
      toast.error(errorMessage(t, error, t('supportTickets.documents.couldNotOpen')));
    } finally {
      setDownloading(null);
    }
  };

  if (ticket.attachments.length === 0) return null;

  return (
    <Card
      title={t('supportTickets.documents.title')}
      description={t('supportTickets.documents.audited')}
      actions={<Badge tone="neutral">{String(ticket.attachments.length)}</Badge>}
      bodyClassName="px-5 py-4"
    >
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ticket.attachments.map((file) => {
          const style = KIND_STYLE[file.kind];
          const KindIcon = style.icon;
          const canPreview = isPreviewable(file);

          return (
            <li
              key={file.id}
              className={cx(
                'group flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-3',
                'shadow-card transition-shadow hover:shadow-card-hover',
              )}
            >
              <div className="flex min-w-0 items-start gap-3">
                <span
                  aria-hidden="true"
                  className={cx(
                    'relative flex h-12 w-11 shrink-0 items-center justify-center rounded-md ring-1 ring-inset',
                    style.plate,
                  )}
                >
                  <KindIcon className="h-6 w-6" />
                  <span className="absolute -bottom-1.5 rounded bg-surface px-1 text-[0.625rem] font-semibold leading-4 tracking-wide text-ink-muted shadow-sm ring-1 ring-border">
                    {extensionOf(file)}
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink" title={file.fileName}>
                    {file.fileName}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    {t(`supportTickets.fileKind.${file.kind}` as TranslationKey)} · {formatFileSize(file.byteSize)}
                  </span>
                  <span className="block text-xs text-ink-muted">
                    {t('supportTickets.documents.uploaded', { when: formatDateTime(file.createdAt) })}
                  </span>
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                {canPreview && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      setViewing(file.id);
                    }}
                    aria-label={t('supportTickets.documents.previewNamed', { name: file.fileName })}
                  >
                    <EyeIcon className="h-4 w-4" />
                    {t('supportTickets.documents.preview')}
                  </Button>
                )}
                <Button
                  size="sm"
                  isLoading={downloading === file.id}
                  onClick={() => {
                    void download(file);
                  }}
                  aria-label={t('supportTickets.documents.downloadNamed', { name: file.fileName })}
                >
                  {downloading !== file.id && <DownloadIcon className="h-4 w-4" />}
                  {t('supportTickets.documents.download')}
                </Button>
              </div>
              {!canPreview && (
                <p className="-mt-1 text-xs text-ink-muted">{t('supportTickets.documents.downloadOnly')}</p>
              )}
            </li>
          );
        })}
      </ul>

      <ImageViewer
        files={previewable}
        currentId={viewing}
        onNavigate={setViewing}
        onClose={() => {
          setViewing(null);
        }}
        load={files.get}
        onDownload={(file) => {
          void download(file);
        }}
      />
    </Card>
  );
}

function ImageViewer({
  files,
  currentId,
  onNavigate,
  onClose,
  load,
  onDownload,
}: {
  files: Attachment[];
  currentId: string | null;
  onNavigate: (id: string) => void;
  onClose: () => void;
  load: (file: Attachment) => Promise<{ blob: Blob; url: string }>;
  onDownload: (file: Attachment) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const index = files.findIndex((file) => file.id === currentId);
  const file = index === -1 ? null : (files[index] ?? null);

  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [actualSize, setActualSize] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (file === null) return undefined;
    let live = true;
    setState({ status: 'loading' });
    load(file).then(
      ({ url }) => {
        if (live) setState({ status: 'ready', url });
      },
      (error: unknown) => {
        if (live) {
          setState({
            status: 'error',
            message: errorMessage(t, error, t('supportTickets.documents.couldNotOpen')),
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [file, load, t, attempt]);

  const step = useCallback(
    (by: number) => {
      if (files.length < 2 || index === -1) return;
      const next = files[(index + by + files.length) % files.length];
      if (next !== undefined) onNavigate(next.id);
    },
    [files, index, onNavigate],
  );

  // Arrow keys step through the images while the viewer is open.
  useEffect(() => {
    if (file === null) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowRight') step(1);
      if (event.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [file, step]);

  return (
    <Modal
      isOpen={file !== null}
      onClose={onClose}
      size="xl"
      title={file?.fileName ?? ''}
      {...(file === null
        ? {}
        : {
            description: `${formatFileSize(file.byteSize)} · ${t('supportTickets.documents.uploaded', {
              when: formatDateTime(file.createdAt),
            })}`,
          })}
      footer={
        file === null ? undefined : (
          <div className="flex w-full flex-wrap items-center gap-2">
            {files.length > 1 && (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    step(-1);
                  }}
                  aria-label={t('supportTickets.documents.previous')}
                >
                  <ChevronLeftIcon className="h-4 w-4" />
                </Button>
                <span className="tabular-nums text-sm text-ink-muted" aria-live="polite">
                  {t('supportTickets.documents.position', {
                    position: String(index + 1),
                    total: String(files.length),
                  })}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    step(1);
                  }}
                  aria-label={t('supportTickets.documents.next')}
                >
                  <ChevronRightIcon className="h-4 w-4" />
                </Button>
              </div>
            )}
            <div className="ml-auto flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={actualSize}
                disabled={state.status !== 'ready'}
                onClick={() => {
                  setActualSize((current) => !current);
                }}
              >
                {actualSize ? t('supportTickets.documents.fitToScreen') : t('supportTickets.documents.actualSize')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onDownload(file);
                }}
              >
                <DownloadIcon className="h-4 w-4" />
                {t('supportTickets.documents.download')}
              </Button>
            </div>
          </div>
        )
      }
    >
      <div
        className={cx(
          'relative flex min-h-64 items-center justify-center rounded-lg bg-surface-sunken ring-1 ring-inset ring-border',
          actualSize ? 'max-h-[65vh] overflow-auto' : 'overflow-hidden',
        )}
      >
        {state.status === 'loading' && (
          <span className="flex flex-col items-center gap-2 py-16 text-sm text-ink-muted" role="status">
            <Spinner className="h-6 w-6" />
            {t('supportTickets.documents.opening')}
          </span>
        )}
        {state.status === 'error' && (
          <div role="alert" className="flex flex-col items-center gap-3 px-6 py-16 text-center text-sm">
            <p className="text-danger">{state.message}</p>
            <Button
              size="sm"
              onClick={() => {
                setAttempt((current) => current + 1);
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        )}
        {state.status === 'ready' && file !== null && (
          <img
            src={state.url}
            alt={t('supportTickets.documents.imageAlt', { name: file.fileName })}
            className={cx(
              'block',
              actualSize ? 'max-w-none' : 'max-h-[65vh] w-auto max-w-full object-contain',
            )}
          />
        )}
      </div>
    </Modal>
  );
}
