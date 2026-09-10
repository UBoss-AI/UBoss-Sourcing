/**
 * Chat enquiries.
 *
 * Everyone who used the storefront chat widget, who they are, and the
 * transcript of what they asked.
 *
 * The screen reads two eras of row and says which is which, because acting on
 * one as though it were the other is a mistake:
 *
 *   - **A conversation with a signed-in customer.** Everything since the
 *     widget moved behind the sign-in. The name, the email and the phone come
 *     off the account, so they are as good as anything else in this panel, and
 *     the row links to the customer.
 *   - **A historical guest enquiry.** The widget used to open with a form
 *     asking for a name, a mobile number and an email, and nothing typed into
 *     it was ever confirmed by an email or an OTP. Those rows are marked, and
 *     they are the only ones where a contact detail is somebody's unchecked
 *     claim. They leave on their own, with the retention sweep.
 *
 * Read-only by design: there is no edit, no note field and no delete. The
 * transcript is evidence of what was asked and answered.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import type { Pagination } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

interface ChatEnquiry {
  id: string;
  /**
   * Off the customer's account where there is one, and otherwise whatever was
   * typed into the old guest form. `isVerifiedContact` says which, and every
   * field is nullable — a customer need not have given a phone number, and a
   * guest row loses its typed details to the retention sweep.
   */
  name: string | null;
  phone: string | null;
  email: string | null;
  isVerifiedContact: boolean;
  customerProfileId: string | null;
  customerName: string | null;
  messageCount: number;
  firstQuestion: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

interface TranscriptMessage {
  id: string;
  role: 'VISITOR' | 'ASSISTANT';
  content: string;
  createdAt: string;
}

interface ChatEnquiryDetail extends ChatEnquiry {
  ipAddress: string | null;
  userAgent: string | null;
  messages: TranscriptMessage[];
}

/**
 * The transcript, in a dialog rather than on its own page.
 *
 * A conversation is read next to the list it came from — "which of these
 * fifteen enquiries is worth a call" is answered by opening three of them in
 * turn, and a full page navigation each time loses the filters and the scroll
 * position that made the comparison possible.
 */
function TranscriptDialog({
  enquiryId,
  onClose,
}: {
  enquiryId: string | null;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const query = useQuery({
    queryKey: ['chat-enquiry', enquiryId],
    queryFn: () => api.get<ChatEnquiryDetail>(`/admin/assistant/conversations/${enquiryId ?? ''}`),
    // Only fetched once a row is chosen; the dialog is mounted the whole time
    // so the query has somewhere to live.
    enabled: enquiryId !== null,
  });

  const enquiry = query.data;

  return (
    <Modal
      isOpen={enquiryId !== null}
      onClose={onClose}
      title={
        enquiry === undefined || enquiry.name === null
          ? t('chatEnquiries.chatTranscript')
          : t('chatEnquiries.chatWith', { name: enquiry.name })
      }
      description={t('chatEnquiries.transcriptDescription')}
      size="lg"
      footer={<Button onClick={onClose}>{t('chatEnquiries.close')}</Button>}
    >
      {query.isPending ? (
        <LoadingState label={t('chatEnquiries.loadingTheTranscript')} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : enquiry === undefined ? null : (
        <div className="space-y-4">
          {/* Contact block. The first thing anybody opening this needs, and on
              a signed-in conversation it comes off the account rather than out
              of a form. Every field can be empty, so each one is guarded: a
              `tel:` link built from a missing number dials nothing and looks
              like it should. */}
          <dl className="grid grid-cols-1 gap-3 rounded-md border border-border bg-surface-sunken p-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                {t('chatEnquiries.name')}
              </dt>
              <dd className="mt-0.5 text-ink">{enquiry.name ?? t('chatEnquiries.notGiven')}</dd>
            </div>
            <div>
              <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                {t('chatEnquiries.mobile')}
              </dt>
              <dd className="mt-0.5">
                {enquiry.phone === null ? (
                  <span className="text-ink-subtle">{t('chatEnquiries.notGiven')}</span>
                ) : (
                  <a
                    href={`tel:${enquiry.phone.replace(/[^+\d]/g, '')}`}
                    className="font-medium text-brand underline underline-offset-2"
                  >
                    {enquiry.phone}
                  </a>
                )}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                {t('chatEnquiries.email')}
              </dt>
              <dd className="mt-0.5 truncate">
                {enquiry.email === null ? (
                  <span className="text-ink-subtle">{t('chatEnquiries.notGiven')}</span>
                ) : (
                  <a
                    href={`mailto:${enquiry.email}`}
                    className="font-medium text-brand underline underline-offset-2"
                  >
                    {enquiry.email}
                  </a>
                )}
              </dd>
            </div>
          </dl>

          {/* Only on a historical guest row. Saying "unverified" under details
              that came off an account would be false, and a warning that is
              always on is a warning nobody reads. */}
          {!enquiry.isVerifiedContact && (
            <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-ink">
              {t('chatEnquiries.unverifiedDetails')}
            </p>
          )}

          <p className="text-xs text-ink-muted">
            Started {formatDateTime(enquiry.createdAt)}
            {enquiry.customerProfileId !== null && (
              <>
                {' · '}
                <Link
                  to={`/customers/${enquiry.customerProfileId}`}
                  className="font-medium text-brand underline underline-offset-2"
                >
                  {t('chatEnquiries.registeredCustomer')}
                  {enquiry.customerName === null ? '' : `: ${enquiry.customerName}`}
                </Link>
              </>
            )}
          </p>

          {/* The transcript itself. Laid out like the widget the visitor used —
              their turns on the right — so a member of staff reads it the way
              it happened. Plain text, never HTML: this is model output. */}
          <div className="space-y-2.5">
            {enquiry.messages.map((message) => (
              <div
                key={message.id}
                className={message.role === 'VISITOR' ? 'flex justify-end' : 'flex justify-start'}
              >
                <div className="max-w-[85%]">
                  <p className="mb-1 text-xxs text-ink-subtle">
                    {message.role === 'VISITOR'
                      ? (enquiry.name ?? t('label.visitor'))
                      : t('chatEnquiries.assistant')}
                    {' · '}
                    {formatDateTime(message.createdAt)}
                  </p>
                  <div
                    className={
                      message.role === 'VISITOR'
                        ? 'rounded-lg bg-brand-fill px-3 py-2 text-sm leading-relaxed text-white'
                        : 'rounded-lg bg-surface-sunken px-3 py-2 text-sm leading-relaxed text-ink ring-1 ring-inset ring-border'
                    }
                  >
                    {message.content.split('\n').map((line, index) => (
                      <p key={index} className={index > 0 ? 'mt-1.5' : undefined}>
                        {line}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Where the conversation came from. Kept at the bottom: useful when
              two enquiries look like the same person, irrelevant otherwise. */}
          {enquiry.ipAddress !== null && (
            <p className="border-t border-border-subtle pt-3 font-mono text-xxs text-ink-subtle">
              {enquiry.ipAddress}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

export function ChatEnquiriesPage(): React.JSX.Element {
  const { t } = useI18n();

  const [searchParams, setSearchParams] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(null);

  const page = Number(searchParams.get('page') ?? '1');
  const search = searchParams.get('q') ?? '';
  const audience = searchParams.get('audience') ?? '';

  const hasFilters = search !== '' || audience !== '';

  const query = useQuery({
    queryKey: ['chat-enquiries', { page, search, audience }],
    queryFn: () =>
      api.get<{ conversations: ChatEnquiry[]; pagination: Pagination }>(
        '/admin/assistant/conversations',
        {
          query: {
            page,
            limit: 25,
            q: search === '' ? undefined : search,
            customersOnly: audience === 'customers' ? true : undefined,
          },
        },
      ),
  });

  const setParam = (key: string, value: string): void => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === '') next.delete(key);
      else next.set(key, value);
      next.delete('page');
      return next;
    });
  };

  const columns: Column<ChatEnquiry>[] = [
    {
      key: 'visitor',
      header: t('label.visitor'),
      render: (row) => (
        <div className="min-w-40">
          <p className="font-medium text-ink">{row.name ?? t('chatEnquiries.notGiven')}</p>
          {row.customerProfileId === null ? (
            <p className="mt-0.5 text-xxs text-ink-subtle">
              {t('chatEnquiries.notARegisteredAccount')}
            </p>
          ) : (
            <Link
              to={`/customers/${row.customerProfileId}`}
              className="mt-0.5 inline-block text-xxs font-medium text-brand underline underline-offset-2"
            >
              {row.customerName ?? t('chatEnquiries.registeredCustomer')}
            </Link>
          )}
        </div>
      ),
    },
    {
      key: 'contact',
      header: t('label.contact'),
      render: (row) => (
        <div className="min-w-44">
          {row.phone === null ? (
            <p className="text-ink-subtle">{t('chatEnquiries.notGiven')}</p>
          ) : (
            <a
              href={`tel:${row.phone.replace(/[^+\d]/g, '')}`}
              className="block text-ink underline decoration-border-strong underline-offset-2 hover:decoration-ink"
            >
              {row.phone}
            </a>
          )}
          {row.email !== null && (
            <a
              href={`mailto:${row.email}`}
              className="mt-0.5 block truncate text-xxs text-ink-muted underline decoration-border underline-offset-2 hover:text-ink"
            >
              {row.email}
            </a>
          )}
        </div>
      ),
    },
    {
      key: 'question',
      header: t('label.openingQuestion'),
      secondary: true,
      render: (row) => (
        <p className="line-clamp-2 min-w-56 max-w-md text-ink-muted">{row.firstQuestion ?? '—'}</p>
      ),
    },
    {
      key: 'messages',
      header: t('label.messages'),
      align: 'right',
      secondary: true,
      tertiary: true,
      render: (row) => <Badge>{formatNumber(row.messageCount)}</Badge>,
    },
    {
      key: 'when',
      header: t('label.lastMessage'),
      nowrap: true,
      render: (row) => (
        <div>
          <p className="text-ink-muted">{formatRelative(row.lastMessageAt)}</p>
          <p className="mt-0.5 text-xxs text-ink-subtle">{formatDateTime(row.lastMessageAt)}</p>
        </div>
      ),
    },
    {
      key: 'transcript',
      header: t('label.chat'),
      render: (row) => (
        <Button
          size="sm"
          onClick={() => {
            setOpenId(row.id);
          }}
        >
          {t('chatEnquiries.readChat')}
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('chatEnquiries.chatEnquiries')}
        description={t('chatEnquiries.pageDescription')}
      />

      <Card>
        <Toolbar>
          <ToolbarField label={t('chatEnquiries.search')} grow>
            <Input
              type="search"
              defaultValue={search}
              placeholder={t('chatEnquiries.nameEmailOrPhone')}
              // Applied on blur or Enter rather than on every keystroke: this
              // is a three-column substring match on the server, and
              // re-querying at "a", "an", "ana" is three wasted round trips.
              onBlur={(event) => {
                setParam('q', event.target.value.trim());
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setParam('q', event.currentTarget.value.trim());
              }}
            />
          </ToolbarField>

          <ToolbarField label={t('chatEnquiries.whoAsked')}>
            <Select
              value={audience}
              onChange={(event) => {
                setParam('audience', event.target.value);
              }}
              className="w-52"
            >
              <option value="">{t('chatEnquiries.everyone')}</option>
              <option value="customers">{t('chatEnquiries.registeredCustomersOnly')}</option>
            </Select>
          </ToolbarField>

          {hasFilters && (
            <ToolbarActions>
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                {t('chatEnquiries.clearFilters')}
              </Button>
            </ToolbarActions>
          )}
        </Toolbar>

        <DataTable
          caption={t('chatEnquiries.chatEnquiries')}
          columns={columns}
          rows={query.data?.conversations}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.isError ? query.error : undefined}
          loadingLabel={t('chatEnquiries.loadingChatEnquiries')}
          minWidth="64rem"
          onRetry={() => {
            void query.refetch();
          }}
          emptyTitle={
            hasFilters ? t('common.nothingMatchesFilters') : t('chatEnquiries.noChatEnquiriesYet')
          }
          emptyDescription={
            hasFilters
              ? t('chatEnquiries.searchMatchesPartOf')
              : t('chatEnquiries.aRowAppearsAfterAQuestion')
          }
          emptyAction={
            hasFilters ? (
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                {t('chatEnquiries.clearFilters')}
              </Button>
            ) : undefined
          }
        />

        {query.data !== undefined && (
          <Pager
            page={query.data.pagination.page}
            limit={query.data.pagination.limit}
            total={query.data.pagination.total}
            totalPages={query.data.pagination.totalPages}
            onPageChange={(next) => {
              setSearchParams((current) => {
                const params = new URLSearchParams(current);
                params.set('page', String(next));
                return params;
              });
            }}
          />
        )}
      </Card>

      <TranscriptDialog
        enquiryId={openId}
        onClose={() => {
          setOpenId(null);
        }}
      />
    </>
  );
}
