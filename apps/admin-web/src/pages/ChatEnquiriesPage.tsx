/**
 * Chat enquiries.
 *
 * Everyone who used the storefront chat widget, with the name, mobile number
 * and email they gave before their first question — and the transcript of what
 * they asked.
 *
 * Two things the screen says out loud, because acting on either without
 * knowing is a mistake:
 *
 *   - **The details are unverified.** The widget asks; it does not confirm by
 *     email or OTP. A number here is what somebody typed into a chat panel.
 *   - **A matched customer is a different thing.** Where the email belongs to
 *     a registered account the row links to it. Where it does not, this person
 *     has no account — and creating one is a decision for the Customers screen,
 *     not a side effect of having chatted.
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

interface ChatEnquiry {
  id: string;
  visitorName: string;
  visitorPhone: string;
  visitorEmail: string;
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
      title={enquiry === undefined ? 'Chat transcript' : `Chat with ${enquiry.visitorName}`}
      description="What the visitor asked and what the assistant answered. Details are as given — nothing here is verified."
      size="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {query.isPending ? (
        <LoadingState label="Loading the transcript" />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : enquiry === undefined ? null : (
        <div className="space-y-4">
          {/* Contact block. The first thing anybody opening this needs, and the
              reason the enquiry was captured at all. */}
          <dl className="grid grid-cols-1 gap-3 rounded-md border border-border bg-surface-sunken p-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                Name
              </dt>
              <dd className="mt-0.5 text-ink">{enquiry.visitorName}</dd>
            </div>
            <div>
              <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                Mobile
              </dt>
              <dd className="mt-0.5">
                <a
                  href={`tel:${enquiry.visitorPhone.replace(/[^+\d]/g, '')}`}
                  className="font-medium text-brand underline underline-offset-2"
                >
                  {enquiry.visitorPhone}
                </a>
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                Email
              </dt>
              <dd className="mt-0.5 truncate">
                <a
                  href={`mailto:${enquiry.visitorEmail}`}
                  className="font-medium text-brand underline underline-offset-2"
                >
                  {enquiry.visitorEmail}
                </a>
              </dd>
            </div>
          </dl>

          <p className="text-xs text-ink-muted">
            Started {formatDateTime(enquiry.createdAt)}
            {enquiry.customerProfileId !== null && (
              <>
                {' · '}
                <Link
                  to={`/customers/${enquiry.customerProfileId}`}
                  className="font-medium text-brand underline underline-offset-2"
                >
                  Registered customer{enquiry.customerName === null ? '' : `: ${enquiry.customerName}`}
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
                    {message.role === 'VISITOR' ? enquiry.visitorName : 'Assistant'}
                    {' · '}
                    {formatDateTime(message.createdAt)}
                  </p>
                  <div
                    className={
                      message.role === 'VISITOR'
                        ? 'rounded-lg bg-brand px-3 py-2 text-sm leading-relaxed text-white'
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
      header: 'Visitor',
      render: (row) => (
        <div className="min-w-40">
          <p className="font-medium text-ink">{row.visitorName}</p>
          {row.customerProfileId === null ? (
            <p className="mt-0.5 text-xxs text-ink-subtle">Not a registered account</p>
          ) : (
            <Link
              to={`/customers/${row.customerProfileId}`}
              className="mt-0.5 inline-block text-xxs font-medium text-brand underline underline-offset-2"
            >
              {row.customerName ?? 'Registered customer'}
            </Link>
          )}
        </div>
      ),
    },
    {
      key: 'contact',
      header: 'Contact',
      render: (row) => (
        <div className="min-w-44">
          <a
            href={`tel:${row.visitorPhone.replace(/[^+\d]/g, '')}`}
            className="block text-ink underline decoration-border-strong underline-offset-2 hover:decoration-ink"
          >
            {row.visitorPhone}
          </a>
          <a
            href={`mailto:${row.visitorEmail}`}
            className="mt-0.5 block truncate text-xxs text-ink-muted underline decoration-border underline-offset-2 hover:text-ink"
          >
            {row.visitorEmail}
          </a>
        </div>
      ),
    },
    {
      key: 'question',
      header: 'Opening question',
      secondary: true,
      render: (row) => (
        <p className="line-clamp-2 min-w-56 max-w-md text-ink-muted">
          {row.firstQuestion ?? '—'}
        </p>
      ),
    },
    {
      key: 'messages',
      header: 'Messages',
      align: 'right',
      secondary: true,
      tertiary: true,
      render: (row) => <Badge>{formatNumber(row.messageCount)}</Badge>,
    },
    {
      key: 'when',
      header: 'Last message',
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
      header: 'Chat',
      render: (row) => (
        <Button
          size="sm"
          onClick={() => {
            setOpenId(row.id);
          }}
        >
          Read chat
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Chat enquiries"
        description="Visitors who used the storefront chat. They gave these details before asking anything — self-declared and unverified, so treat a match to a customer account as the only confirmed identity here."
      />

      <Card>
        <Toolbar>
          <ToolbarField label="Search" grow>
            <Input
              type="search"
              defaultValue={search}
              placeholder="Name, email or phone"
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

          <ToolbarField label="Who asked">
            <Select
              value={audience}
              onChange={(event) => {
                setParam('audience', event.target.value);
              }}
              className="w-52"
            >
              <option value="">Everyone</option>
              <option value="customers">Registered customers only</option>
            </Select>
          </ToolbarField>

          {hasFilters && (
            <ToolbarActions>
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                Clear filters
              </Button>
            </ToolbarActions>
          )}
        </Toolbar>

        <DataTable
          caption="Chat enquiries"
          columns={columns}
          rows={query.data?.conversations}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.isError ? query.error : undefined}
          loadingLabel="Loading chat enquiries"
          minWidth="64rem"
          onRetry={() => {
            void query.refetch();
          }}
          emptyTitle={hasFilters ? 'Nothing matches these filters' : 'No chat enquiries yet'}
          emptyDescription={
            hasFilters
              ? 'Search matches part of a name, an email address or a phone number.'
              : 'A row appears here as soon as a visitor gives their details and asks the storefront assistant a question.'
          }
          emptyAction={
            hasFilters ? (
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                Clear filters
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
