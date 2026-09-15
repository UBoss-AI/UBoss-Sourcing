/**
 * Companies — every business that reaches this marketplace, in one tree.
 *
 * The screen exists because an operator could not previously answer a simple
 * question. Customers, Sellers and Carriers are three lists of accounts, and
 * nothing on any of them says that the seller called "Northwind Medical", the
 * four buying accounts whose employer is "Northwind Medical Ltd" and the
 * carrier "Northwind Logistics" are one business — or that the person who owns
 * that seller organisation is the same person who placed last Tuesday's order
 * from the buying side.
 *
 * So this page is not a fourth list. It is the three, grouped by company and
 * nested: **company → its accounts → the people inside them**, with every row
 * linking to the screen that can actually change something. Nothing is edited
 * here; see the route's header for why.
 *
 * WHAT THE INDENTATION MEANS
 *
 * Three levels, and the reader should never have to guess which they are on:
 * a company is a card, an account is a panel inside it with its own coloured
 * badge, and a person is a row inside the card's people list carrying the badge
 * of every account they belong to. That last part is the point of the whole
 * screen — one row, two badges, which is how an operator sees that a buyer and
 * a seller are the same human being.
 *
 * ONE CARD OPEN AT A TIME IS NOT ENFORCED
 *
 * Several can be open. An operator comparing two companies is the ordinary
 * case, and a list that collapses what you just read to show what you clicked
 * is a list you have to keep re-opening.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Pager } from '@/components/DataTable';
import {
  Badge,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  PageHeader,
  Select,
  SummaryTiles,
  Toolbar,
  ToolbarField,
} from '@/components/ui';
import { cx } from '@/lib/cx';
import {
  fetchDirectory,
  humanise,
  kindLabel,
  kindTone,
  partnerStatusTone,
  sellerStatusLabel,
  sellerStatusTone,
  type DirectoryCompany,
  type DirectoryPerson,
} from '@/lib/directory';

const PAGE_SIZE = 25;

const KINDS = [
  { value: '', label: 'Every company' },
  { value: 'SELLER', label: 'Sellers' },
  { value: 'BUYER', label: 'Buyers' },
  { value: 'LOGISTICS', label: 'Carriers' },
] as const;

/**
 * A company's mark, or its initial.
 *
 * Only a seller has a logo here — a buying account and a carrier have no
 * branding in this product — so everything else gets the same tinted square
 * with an initial rather than a broken image or an empty space that makes the
 * list ragged.
 */
function CompanyMark({
  name,
  logoUrl,
}: {
  name: string;
  logoUrl: string | null;
}): React.JSX.Element {
  const initial = name.trim().charAt(0).toUpperCase();

  if (logoUrl === null) {
    return (
      <span
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-soft text-sm font-semibold text-accent"
      >
        {initial.length === 0 ? '?' : initial}
      </span>
    );
  }

  return (
    <img
      src={logoUrl}
      alt=""
      aria-hidden="true"
      className="h-10 w-10 shrink-0 rounded-md border border-border object-contain"
    />
  );
}

/** One person, and every role this company's accounts give them. */
function PersonRow({ person }: { person: DirectoryPerson }): React.JSX.Element {
  const body = (
    <>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink">{person.name}</p>
        <p className="truncate text-xxs text-ink-subtle">{person.email}</p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {person.roles.map((role) => (
          <Badge key={`${role.kind}-${role.label}`} tone={kindTone(role.kind)}>
            {kindLabel(role.kind)} · {role.label}
          </Badge>
        ))}
        {person.ordersPlaced > 0 && (
          <span className="tabular text-xxs text-ink-muted">
            {person.ordersPlaced} order{person.ordersPlaced === 1 ? '' : 's'}
          </span>
        )}
        {person.accountStatus !== 'ACTIVE' && (
          <Badge tone="warning">{humanise(person.accountStatus)}</Badge>
        )}
      </div>
    </>
  );

  /*
   * A logistics person has no customer profile, so there is no customer screen
   * to open — their record lives on the carrier's own page, which the account
   * panel above already links to. Rendering a dead link would be worse than
   * rendering a plain row.
   */
  if (person.customerProfileId === null) {
    return (
      <div className="flex items-center justify-between gap-4 border-b border-border-subtle px-4 py-2.5 last:border-b-0">
        {body}
      </div>
    );
  }

  return (
    <Link
      to={`/customers/${person.customerProfileId}`}
      className="flex items-center justify-between gap-4 border-b border-border-subtle px-4 py-2.5 last:border-b-0 hover:bg-surface-hover"
    >
      {body}
    </Link>
  );
}

/** One of a company's accounts: what it is, how it is doing, where to open it. */
function AccountPanel({
  title,
  to,
  badge,
  subtitle,
  tiles,
}: {
  title: string;
  to: string | null;
  badge: React.JSX.Element;
  subtitle: string;
  tiles: { label: string; value: React.ReactNode }[];
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {badge}
            {to === null ? (
              <span className="truncate text-sm font-semibold text-ink">{title}</span>
            ) : (
              <Link
                to={to}
                className="truncate text-sm font-semibold text-ink hover:text-accent"
              >
                {title}
              </Link>
            )}
          </div>
          <p className="mt-0.5 truncate text-xxs text-ink-subtle">{subtitle}</p>
        </div>
      </div>

      <SummaryTiles className="mt-3" items={tiles} />
    </div>
  );
}

function CompanyCard({ company }: { company: DirectoryCompany }): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);

  const accountCount =
    (company.seller === null ? 0 : 1) +
    (company.logistics === null ? 0 : 1) +
    (company.buyer === null ? 0 : 1);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-card">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen((open) => !open);
        }}
        className="flex w-full items-center gap-4 px-4 py-3.5 text-left transition-colors hover:bg-surface-hover"
      >
        <CompanyMark name={company.name} logoUrl={company.seller?.logoUrl ?? null} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-ink">{company.name}</p>
            {company.kinds.map((kind) => (
              <Badge key={kind} tone={kindTone(kind)}>
                {kindLabel(kind)}
              </Badge>
            ))}
          </div>
          <p className="mt-0.5 text-xxs text-ink-subtle">
            {accountCount} account{accountCount === 1 ? '' : 's'} · {company.people.length} person
            {company.people.length === 1 ? '' : 's'}
            {company.hasMorePeople ? ' (more not shown)' : ''}
            {company.country === null ? '' : ` · ${company.country}`}
          </p>
        </div>

        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cx(
            'h-4 w-4 shrink-0 text-ink-subtle transition-transform',
            isOpen && 'rotate-90',
          )}
        >
          <path d="m8 5 5 5-5 5" />
        </svg>
      </button>

      {isOpen && (
        <div className="space-y-4 border-t border-border bg-surface px-4 py-4">
          <div className="grid gap-3 lg:grid-cols-2">
            {company.seller !== null && (
              <AccountPanel
                title={company.seller.displayName}
                to={`/sellers/${company.seller.id}`}
                badge={
                  <Badge tone={sellerStatusTone(company.seller.status)} dot>
                    {sellerStatusLabel(company.seller.status)}
                  </Badge>
                }
                subtitle={`${company.seller.legalName} · ${humanise(company.seller.kind)} · ${company.seller.registrationCountry}`}
                tiles={[
                  { label: 'Live', value: company.seller.liveListings },
                  { label: 'In review', value: company.seller.listingsInReview },
                  { label: 'Drafts', value: company.seller.draftListings },
                  { label: 'Orders', value: company.seller.ordersReceived },
                ]}
              />
            )}

            {company.logistics !== null && (
              <AccountPanel
                title={company.logistics.displayName}
                to={`/logistics/partners/${company.logistics.id}`}
                badge={
                  <Badge tone={partnerStatusTone(company.logistics.status)} dot>
                    {humanise(company.logistics.status)}
                  </Badge>
                }
                subtitle={`${company.logistics.partnerCode} · ${company.logistics.legalName} · ${company.logistics.registrationCountry}`}
                tiles={[
                  { label: 'Open', value: company.logistics.openShipments },
                  { label: 'People', value: company.logistics.memberCount },
                  { label: 'Contract', value: humanise(company.logistics.contractStatus) },
                ]}
              />
            )}

            {company.buyer !== null && (
              <AccountPanel
                title="Buying accounts"
                /*
                 * Filtered by the organisation exactly as the buyers typed it.
                 * The first spelling only — the Customers screen searches one
                 * string, and every spelling is listed in the subtitle so an
                 * operator can see there was more than one.
                 */
                to={`/customers?q=${encodeURIComponent(company.buyer.organisationNames[0] ?? company.name)}`}
                badge={<Badge tone="neutral">Buys</Badge>}
                subtitle={company.buyer.organisationNames.join(' · ')}
                tiles={[
                  { label: 'Accounts', value: company.buyer.profileCount },
                  { label: 'Orders', value: company.buyer.ordersPlaced },
                  { label: 'Listed here', value: company.people.length },
                ]}
              />
            )}
          </div>

          <div className="overflow-hidden rounded-lg border border-border">
            <p className="border-b border-border bg-surface-sunken px-4 py-2 text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              People
            </p>

            {company.people.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-muted">
                Nobody has signed in under this company yet.
              </p>
            ) : (
              <div>
                {company.people.map((person) => (
                  <PersonRow key={person.userId} person={person} />
                ))}
              </div>
            )}

            {company.hasMorePeople && (
              <p className="border-t border-border-subtle px-4 py-2.5 text-xxs text-ink-muted">
                More people belong to this company than are shown. Open the account above to see
                all of them.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function CompaniesPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();

  const search = params.get('search') ?? '';
  const kind = params.get('kind') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1'));

  const query = useQuery({
    queryKey: ['admin', 'directory', search, kind, page],
    queryFn: () => {
      const next = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (search.length > 0) next.set('search', search);
      if (kind.length > 0) next.set('kind', kind);
      return fetchDirectory(next);
    },
  });

  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value.length === 0) next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const data = query.data;

  return (
    <div>
      <PageHeader
        title="Companies"
        description="Every business here, and which of its accounts buys, sells and carries. Open one to see its accounts and the people inside them."
      />

      {data !== undefined && (
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
            <p className="text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">
              Sellers
            </p>
            <p className="tabular mt-2 text-title text-ink">{data.counts.sellers}</p>
            <p className="mt-1 text-xs text-ink-muted">Businesses listing their own products</p>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
            <p className="text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">
              Buying companies
            </p>
            <p className="tabular mt-2 text-title text-ink">{data.counts.buyerOrganisations}</p>
            <p className="mt-1 text-xs text-ink-muted">
              Named by their staff on their own accounts
            </p>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
            <p className="text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">
              Carriers
            </p>
            <p className="tabular mt-2 text-title text-ink">{data.counts.logistics}</p>
            <p className="mt-1 text-xs text-ink-muted">Logistics partners under contract</p>
          </div>
        </div>
      )}

      <Card>
        <Toolbar>
          <ToolbarField label="Search" grow>
            <Input
              type="search"
              defaultValue={search}
              placeholder="Company, trading name, carrier code"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  update('search', event.currentTarget.value.trim());
                }
              }}
            />
          </ToolbarField>

          <ToolbarField label="Shows">
            <Select
              value={kind}
              onChange={(event) => {
                update('kind', event.target.value);
              }}
            >
              {KINDS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </ToolbarField>
        </Toolbar>

        <div className="px-4 py-4">
          {query.isPending && <LoadingState label="Reading the directory" />}

          {query.isError && (
            <ErrorState
              error={query.error}
              onRetry={() => {
                void query.refetch();
              }}
            />
          )}

          {data !== undefined && (
            <div className="space-y-4">
              {data.isTruncated && (
                <Callout tone="warning" title="More companies matched than can be listed">
                  Narrow the search to see the rest. The counts above cover what was read, not
                  every company on the system.
                </Callout>
              )}

              {data.companies.length === 0 ? (
                <EmptyState
                  title="No companies match"
                  description="Try a shorter search, or change what the list shows."
                />
              ) : (
                <div className="space-y-3">
                  {data.companies.map((company) => (
                    <CompanyCard key={company.key} company={company} />
                  ))}
                </div>
              )}

              {/*
                Buyers who never named an employer.

                Deliberately not dressed up as companies: on a marketplace an
                individual buying from a home address is ordinary, and inventing
                a one-person "company" for each of them would bury the businesses
                this screen exists to show.
              */}
              {data.unlistedBuyers !== null && data.unlistedBuyers.total > 0 && (
                <div className="overflow-hidden rounded-lg border border-dashed border-border bg-surface">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-ink">Buyers with no company named</p>
                      <p className="mt-0.5 text-xxs text-ink-subtle">
                        {data.unlistedBuyers.total} account
                        {data.unlistedBuyers.total === 1 ? '' : 's'} · anybody can open one and buy
                      </p>
                    </div>
                    <Link
                      to="/customers"
                      className="text-xs font-medium text-accent hover:underline"
                    >
                      Open Customers →
                    </Link>
                  </div>

                  {data.unlistedBuyers.sample.map((person) => (
                    <PersonRow key={person.userId} person={person} />
                  ))}
                </div>
              )}

              <Pager
                page={data.page}
                limit={data.pageSize}
                total={data.total}
                totalPages={Math.max(1, Math.ceil(data.total / data.pageSize))}
                onPageChange={(next) => {
                  update('page', String(next));
                }}
              />
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
