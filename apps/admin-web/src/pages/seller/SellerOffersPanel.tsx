/**
 * A seller's listings, and the marketplace's power to block one
 * (checklist SCREEN-067). On the seller detail page.
 *
 * Read with product.read. Blocking and lifting a block need product.publish:
 * the same authority that puts a listing on sale in the first place.
 *
 * What the rules are, and the server enforces:
 *   - A block needs a reason, and the seller reads it as written.
 *   - A blocked listing leaves the shelf at once. The seller cannot resume,
 *     pause, archive or edit it; only staff lift the block.
 *   - Lifting a block returns a listing that was on sale as PAUSED, so the
 *     seller's own checks run before it sells again.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, Field, LoadingState, Textarea } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';

type OfferStatus = 'INACTIVE' | 'ACTIVE' | 'PAUSED' | 'NEEDS_CHANGES' | 'ARCHIVED' | 'BLOCKED';

export interface AdminOfferRow {
  id: string;
  sellerSku: string;
  productName: string;
  status: OfferStatus;
  statusReason: string | null;
  blockedReason: string | null;
  blockedAt: string | null;
  priceMinor: string;
  currency: string;
  updatedAt: string;
}

interface OfferPage {
  rows: AdminOfferRow[];
  total: number;
}

const PAGE_SIZE = 25;

const TONE: Record<OfferStatus, BadgeTone> = {
  ACTIVE: 'success',
  INACTIVE: 'neutral',
  PAUSED: 'neutral',
  NEEDS_CHANGES: 'warning',
  ARCHIVED: 'neutral',
  BLOCKED: 'danger',
};

/** A reason shorter than this is not one the seller can act on. */
const MIN_REASON = 5;

export function SellerOffersPanel({ sellerId }: { sellerId: string }): React.JSX.Element {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const key = ['admin', 'seller', sellerId, 'offers', page];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.get<OfferPage>(`/admin/sellers/${sellerId}/offers?page=${String(page)}&pageSize=${String(PAGE_SIZE)}`),
  });
  const pageCount = query.data === undefined ? 1 : Math.max(1, Math.ceil(query.data.total / PAGE_SIZE));

  return (
    <Card title={t('sellerOffers.title')} description={t('sellerOffers.description')}>
      {query.isPending && <LoadingState label={t('sellerOffers.loading')} />}
      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {query.isSuccess && query.data.rows.length === 0 && (
        <EmptyState title={t('sellerOffers.empty')} description={t('sellerOffers.emptyHint')} />
      )}
      {query.isSuccess && query.data.rows.length > 0 && (
        <div className="px-5 py-4 text-sm">
          <ul className="divide-y divide-border-subtle" aria-label={t('sellerOffers.title')}>
            {query.data.rows.map((row) => (
              <OfferRow key={row.id} row={row} sellerId={sellerId} />
            ))}
          </ul>
          {pageCount > 1 && (
            <nav className="mt-4 flex items-center justify-between" aria-label={t('sellerOffers.pages')}>
              <Button
                size="sm"
                disabled={page <= 1}
                onClick={() => {
                  setPage(page - 1);
                }}
              >
                {t('sellerOffers.previous')}
              </Button>
              <span className="text-xs text-ink-muted">{t('sellerOffers.pageOf', { page: String(page), pages: String(pageCount) })}</span>
              <Button
                size="sm"
                disabled={page >= pageCount}
                onClick={() => {
                  setPage(page + 1);
                }}
              >
                {t('sellerOffers.next')}
              </Button>
            </nav>
          )}
        </div>
      )}
    </Card>
  );
}

function OfferRow({ row, sellerId }: { row: AdminOfferRow; sellerId: string }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const canModerate = can(Permission.PRODUCT_PUBLISH);
  const [dialog, setDialog] = useState<'block' | 'unblock' | null>(null);

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="break-words font-medium text-ink">{row.productName}</p>
        <p className="text-xs text-ink-muted">
          {row.sellerSku} · {formatDate(row.updatedAt)}
        </p>
        {row.status === 'BLOCKED' && row.blockedReason !== null && (
          <p className="mt-1 break-words text-xs text-danger">{t('sellerOffers.blockedReason', { reason: row.blockedReason })}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={TONE[row.status]}>{t(`sellerOffers.status.${row.status}` as TranslationKey)}</Badge>
        {canModerate && row.status === 'BLOCKED' && (
          <Button
            size="sm"
            onClick={() => {
              setDialog('unblock');
            }}
          >
            {t('sellerOffers.unblock')}
          </Button>
        )}
        {canModerate && row.status !== 'BLOCKED' && row.status !== 'ARCHIVED' && (
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              setDialog('block');
            }}
          >
            {t('sellerOffers.block')}
          </Button>
        )}
      </div>
      {dialog === 'block' && (
        <BlockDialog
          row={row}
          sellerId={sellerId}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
      {dialog === 'unblock' && (
        <UnblockDialog
          row={row}
          sellerId={sellerId}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
    </li>
  );
}

function BlockDialog({ row, sellerId, onClose }: { row: AdminOfferRow; sellerId: string; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [reason, setReason] = useState('');
  const [tooShort, setTooShort] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (text: string) => api.post(`/admin/seller-offers/${row.id}/block`, { reason: text }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'seller', sellerId, 'offers'] });
      toast.success(t('sellerOffers.blocked'));
      onClose();
    },
    onError: (error: unknown) => {
      setProblem(errorMessage(t, error, t('sellerOffers.blockFailed')));
    },
  });

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('sellerOffers.blockTitle', { code: row.sellerSku })}
      description={t('sellerOffers.blockIntro')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            isLoading={mutation.isPending}
            onClick={() => {
              const text = reason.trim();
              setTooShort(text.length < MIN_REASON);
              if (text.length >= MIN_REASON) mutation.mutate(text);
            }}
          >
            {t('sellerOffers.blockConfirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label={t('sellerOffers.reasonLabel')}
          hint={t('sellerOffers.reasonHint')}
          error={tooShort ? t('sellerOffers.reasonRequired') : undefined}
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              maxLength={1000}
              value={reason}
              onChange={(event) => {
                setReason(event.currentTarget.value);
              }}
            />
          )}
        </Field>
        {problem !== null && (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}

function UnblockDialog({ row, sellerId, onClose }: { row: AdminOfferRow; sellerId: string; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/admin/seller-offers/${row.id}/unblock`, note.trim() === '' ? {} : { note: note.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'seller', sellerId, 'offers'] });
      toast.success(t('sellerOffers.unblocked'));
      onClose();
    },
    onError: (error: unknown) => {
      setProblem(errorMessage(t, error, t('sellerOffers.unblockFailed')));
    },
  });

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('sellerOffers.unblockTitle', { code: row.sellerSku })}
      description={t('sellerOffers.unblockIntro')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            isLoading={mutation.isPending}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {t('sellerOffers.unblockConfirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('sellerOffers.noteLabel')} hint={t('sellerOffers.noteHint')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              maxLength={1000}
              value={note}
              onChange={(event) => {
                setNote(event.currentTarget.value);
              }}
            />
          )}
        </Field>
        {problem !== null && (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}
