/**
 * One submitted listing, and the decision on it.
 *
 * The whole point of this screen is that a decision is made against what the
 * seller actually sent — the photographs, the answers, the price, the stock —
 * rather than against a queue row. Approving a listing is what makes it buyable
 * on this marketplace, so approving one you have not looked at is the failure
 * this page exists to make impossible.
 *
 * **Per-field comments are the feature, not a nicety.** "Your listing is not
 * acceptable" sends a seller to guess; a note attached to `PRODUCT_PHOTOS` /
 * `UDI_LABEL` puts the sentence beside the slot in their own wizard, which is
 * the difference between a review they can act on and one they cannot. Every
 * field and every photo slot therefore carries a "Note" control, and the notes
 * collect into the decision panel so the moderator sees the whole reply before
 * sending it.
 *
 * What is read-only here, and deliberately: a moderator does not correct a
 * seller's listing. They say what is wrong and send it back. Editing somebody
 * else's description would leave the seller answering for words they did not
 * write, which is exactly what the audit trail cannot express.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { SellerContentPreview } from './listing-review/SellerContentPreview';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  Textarea,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cx } from '@/lib/cx';
import { formatRelative } from '@/lib/format';
import {
  LISTING_SECTIONS,
  decideListing,
  fetchListingForReview,
  type ListingReviewDetail,
  type ListingSchemaAttribute,
  type ListingSection,
} from '@/lib/sellers';

const SECTION_LABELS: Record<ListingSection, string> = {
  PRODUCT_PHOTOS: 'Photographs',
  PRICE_STOCK_SHIPPING: 'Price, stock and shipping',
  PRODUCT_DESCRIPTION: 'Description',
  ADDITIONAL_INFORMATION: 'Additional information',
  MEDICAL_COMPLIANCE: 'Compliance',
};

type Decision = 'APPROVED' | 'ACTION_REQUIRED' | 'REJECTED';

const DECISIONS: Record<
  Decision,
  { title: string; verb: string; tone: 'primary' | 'danger'; needsComment: boolean }
> = {
  APPROVED: {
    title: 'Approve this listing',
    verb: 'Approve',
    tone: 'primary',
    needsComment: false,
  },
  ACTION_REQUIRED: {
    title: 'Send it back to the seller',
    verb: 'Send it back',
    tone: 'primary',
    needsComment: true,
  },
  REJECTED: { title: 'Reject this listing', verb: 'Reject', tone: 'danger', needsComment: true },
};

/** A note a moderator has attached to one field or one photo slot. */
interface FieldNote {
  section: ListingSection | null;
  attributeKey: string | null;
  message: string;
}

export function ListingReviewPage(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>();

  const query = useQuery({
    queryKey: ['admin', 'listing-review', 'detail', id],
    queryFn: () => fetchListingForReview(id),
    enabled: id.length > 0,
  });

  const [notes, setNotes] = useState<FieldNote[]>([]);
  const [deciding, setDeciding] = useState<Decision | null>(null);

  const addNote = (note: FieldNote): void => {
    setNotes((current) => [...current, note]);
  };

  const removeNote = (index: number): void => {
    setNotes((current) => current.filter((_, position) => position !== index));
  };

  if (query.isPending) return <LoadingState label="Loading the listing" />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const listing = query.data;
  const isDecidable = listing.status === 'PENDING_REVIEW';

  return (
    <div className="space-y-5">
      <PageHeader
        title={listing.title ?? 'Untitled listing'}
        description={
          listing.submittedVersion === null
            ? `${listing.sellerName} · submitted ${formatRelative(listing.submittedAt)}`
            : // The revision, beside the time. Two administrators comparing
              // notes need something more precise than "this morning", and it
              // is the number the decision is pinned to.
              `${listing.sellerName} · submitted ${formatRelative(listing.submittedAt)} · revision ${String(listing.submittedVersion)}`
        }
        back={{ to: '/listing-review', label: 'Listing review' }}
      />

      {!isDecidable && (
        <Callout tone="info" title="This listing is not waiting for a decision">
          <p className="text-sm">
            Its status is {listing.status.toLowerCase().replace(/_/g, ' ')}. You are looking at what
            was submitted; nothing here can be decided again.
          </p>
        </Callout>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-5">
          <Facts listing={listing} />
          <Photographs listing={listing} onNote={addNote} disabled={!isDecidable} />
          <Commercials listing={listing} onNote={addNote} disabled={!isDecidable} />
          <Answers listing={listing} onNote={addNote} disabled={!isDecidable} />
          <SellerContentPreview content={listing.content} />
        </div>

        <div className="space-y-5 lg:sticky lg:top-5 lg:self-start">
          <OpenIssues listing={listing} />
          <NotePanel
            notes={notes}
            onRemove={removeNote}
            disabled={!isDecidable}
            onDecide={(decision) => {
              setDeciding(decision);
            }}
          />
        </div>
      </div>

      {deciding !== null && (
        <DecisionDialog
          listing={listing}
          decision={deciding}
          notes={notes}
          onClose={() => {
            setDeciding(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The listing itself
// ---------------------------------------------------------------------------

function Facts({ listing }: { listing: ListingReviewDetail }): React.JSX.Element {
  return (
    <Card title="What this claims to be" bodyClassName="px-5 py-4">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Seller">
          <Link to={`/sellers/${listing.sellerAccountId}`} className="text-brand hover:underline">
            {listing.sellerName}
          </Link>
        </Fact>
        <Fact label="Seller's own code">{listing.sellerSku ?? '—'}</Fact>
        <Fact label="Brand">
          {listing.brandName === null ? (
            '—'
          ) : (
            <span className="inline-flex items-center gap-2">
              {listing.brandName}
              {listing.brandStatus !== 'APPROVED' && (
                <Badge tone="warning">{listing.brandStatus?.toLowerCase() ?? 'unapproved'}</Badge>
              )}
            </span>
          )}
        </Fact>
        <Fact label="Category">
          {listing.categoryPath.length === 0
            ? '—'
            : listing.categoryPath.map((step) => step.name).join(' › ')}
        </Fact>
        <Fact label="Title">
          {/*
            Which title, and where it came from. A marketplace that lets sellers
            write their own has to show the moderator that this one was written
            rather than generated — it is the string a buyer searches on, and it
            is the thing most worth objecting to.
          */}
          {listing.sellerEditedTitle === null ? (
            <span className="text-ink-muted">Generated: {listing.generatedTitle ?? '—'}</span>
          ) : (
            <span>
              {listing.sellerEditedTitle}{' '}
              <Badge tone="warning">written by the seller</Badge>
            </span>
          )}
        </Fact>
        <Fact label="Last changed">{formatRelative(listing.updatedAt)}</Fact>
      </dl>
    </Card>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className="mt-1 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

function Photographs({
  listing,
  onNote,
  disabled,
}: {
  listing: ListingReviewDetail;
  onNote: (note: FieldNote) => void;
  disabled: boolean;
}): React.JSX.Element {
  const slots = listing.schema?.mediaSlots ?? [];
  const bySlot = new Map(listing.media.map((item) => [item.slot, item]));

  // Slots the category asks for, plus anything uploaded into a slot it does
  // not — which is itself worth seeing, rather than silently dropping.
  const extra = listing.media.filter(
    (item) => !slots.some((requirement) => requirement.slot === item.slot),
  );

  return (
    <Card
      title="Photographs and video"
      description="What the buyer will see. A slot the category requires and nobody filled is shown empty rather than hidden."
      bodyClassName="px-5 py-4"
    >
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {slots.map((requirement) => {
          const item = bySlot.get(requirement.slot);

          return (
            <li key={requirement.slot} className="space-y-2">
              <div
                className={cx(
                  'flex aspect-square items-center justify-center overflow-hidden rounded-lg border',
                  item === undefined
                    ? requirement.isRequired
                      ? 'border-dashed border-danger/40 bg-danger-soft'
                      : 'border-dashed border-border bg-surface-sunken'
                    : 'border-border bg-surface-sunken',
                )}
              >
                {item === undefined ? (
                  <span
                    className={cx(
                      'px-2 text-center text-xxs',
                      requirement.isRequired ? 'text-danger' : 'text-ink-subtle',
                    )}
                  >
                    {requirement.isRequired ? 'Required, missing' : 'Not sent'}
                  </span>
                ) : item.url === null ? (
                  <span className="px-2 text-center text-xxs text-ink-subtle">
                    Upload never finished
                  </span>
                ) : item.kind === 'VIDEO' ? (
                  /*
                    eslint-disable-next-line jsx-a11y/media-has-caption --
                    A caption track cannot exist here. The file was uploaded by
                    a seller and nothing in this system can produce subtitles
                    for it, so a `<track>` would point at something that does
                    not exist. The seller's own written description of the video
                    is what carries the meaning instead, and it is shown beneath
                    the player as visible text.
                  */
                  <video
                    src={item.url}
                    controls
                    preload="metadata"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <img
                    src={item.url}
                    alt={item.altText ?? requirement.label}
                    className="h-full w-full object-cover"
                  />
                )}
              </div>

              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xxs font-medium text-ink">{requirement.label}</p>
                  {item?.isPrimary === true && (
                    <span className="text-xxs text-ink-subtle">Main picture</span>
                  )}
                </div>
                <NoteButton
                  disabled={disabled}
                  label={requirement.label}
                  onNote={(message) => {
                    onNote({
                      section: 'PRODUCT_PHOTOS',
                      attributeKey: requirement.slot,
                      message,
                    });
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {extra.length > 0 && (
        <div className="mt-4 border-t border-border-subtle pt-4">
          <p className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
            Sent, but not a slot this category asks for
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {extra.map((item) => (
              <li key={item.id} className="text-xs text-ink-muted">
                {item.slot.replace(/_/g, ' ').toLowerCase()}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Commercials({
  listing,
  onNote,
  disabled,
}: {
  listing: ListingReviewDetail;
  onNote: (note: FieldNote) => void;
  disabled: boolean;
}): React.JSX.Element {
  const offer = listing.offer as {
    priceMinor?: string | null;
    currency?: string | null;
    minimumOrderQuantity?: number | null;
    orderIncrement?: number | null;
    orderingUnit?: string | null;
    handlingTimeDays?: number | null;
    priceTiers?: { minQuantity: number; priceMinor: string }[] | null;
  };

  const stock = listing.stock as {
    locationId?: string;
    availableQuantity?: number;
    batchNumber?: string | null;
    expiresOn?: string | null;
  }[];

  const packaging = listing.packaging;

  return (
    <Card
      title="Price, stock and packing"
      actions={
        <NoteButton
          disabled={disabled}
          label="price and stock"
          onNote={(message) => {
            onNote({ section: 'PRICE_STOCK_SHIPPING', attributeKey: null, message });
          }}
        />
      }
      bodyClassName="px-5 py-4"
    >
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Price">
          {/*
            Minor units, printed as the seller stored them rather than divided
            by a guess. The exponent belongs to the currency and this screen has
            no business inventing one.
          */}
          {offer.priceMinor == null
            ? '—'
            : `${offer.currency ?? ''} ${offer.priceMinor} (minor units)`}
        </Fact>
        <Fact label="Sold in">{offer.orderingUnit ?? '—'}</Fact>
        <Fact label="Minimum order">{offer.minimumOrderQuantity ?? '—'}</Fact>
        <Fact label="Order increment">{offer.orderIncrement ?? '—'}</Fact>
        <Fact label="Handling time">
          {offer.handlingTimeDays == null ? '—' : `${String(offer.handlingTimeDays)} days`}
        </Fact>
        <Fact label="Price breaks">
          {offer.priceTiers == null || offer.priceTiers.length === 0
            ? 'None'
            : offer.priceTiers
                .map((tier) => `${String(tier.minQuantity)}+ at ${tier.priceMinor}`)
                .join(', ')}
        </Fact>
      </dl>

      <div className="mt-4 border-t border-border-subtle pt-4">
        <p className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">Stock</p>
        {stock.length === 0 ? (
          <p className="mt-1 text-sm text-ink-subtle">None declared anywhere.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {stock.map((entry, index) => (
              <li key={index}>
                {String(entry.availableQuantity ?? 0)} at location {entry.locationId ?? '—'}
                {entry.batchNumber == null ? '' : ` · batch ${entry.batchNumber}`}
                {entry.expiresOn == null ? '' : ` · expires ${entry.expiresOn}`}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 border-t border-border-subtle pt-4">
        <p className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
          How it is packed
        </p>
        {Object.keys(packaging).length === 0 ? (
          <p className="mt-1 text-sm text-ink-subtle">Nothing given.</p>
        ) : (
          <dl className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(packaging).map(([key, value]) => (
              <Fact key={key} label={key.replace(/([A-Z])/g, ' $1').toLowerCase()}>
                {formatValue(value)}
              </Fact>
            ))}
          </dl>
        )}
      </div>
    </Card>
  );
}

function Answers({
  listing,
  onNote,
  disabled,
}: {
  listing: ListingReviewDetail;
  onNote: (note: FieldNote) => void;
  disabled: boolean;
}): React.JSX.Element | null {
  const attributes = listing.schema?.attributes ?? [];

  // Only the sections that ask something. A category with no compliance fields
  // should not show an empty "Compliance" panel for a moderator to wonder about.
  const sections = LISTING_SECTIONS.filter(
    (section) =>
      section !== 'PRODUCT_PHOTOS' &&
      section !== 'PRICE_STOCK_SHIPPING' &&
      attributes.some((attribute) => attribute.section === section),
  );

  if (sections.length === 0) return null;

  return (
    <>
      {sections.map((section) => (
        <Card
          key={section}
          title={SECTION_LABELS[section]}
          actions={
            <NoteButton
              disabled={disabled}
              label={SECTION_LABELS[section]}
              onNote={(message) => {
                onNote({ section, attributeKey: null, message });
              }}
            />
          }
          bodyClassName="px-5 py-4"
        >
          <ul className="divide-y divide-border-subtle">
            {attributes
              .filter((attribute) => attribute.section === section)
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((attribute) => (
                <AnswerRow
                  key={attribute.attributeKey}
                  attribute={attribute}
                  value={listing.attributes[attribute.attributeKey]}
                  disabled={disabled}
                  onNote={(message) => {
                    onNote({ section, attributeKey: attribute.attributeKey, message });
                  }}
                />
              ))}
          </ul>
        </Card>
      ))}
    </>
  );
}

function AnswerRow({
  attribute,
  value,
  onNote,
  disabled,
}: {
  attribute: ListingSchemaAttribute;
  value: unknown;
  onNote: (message: string) => void;
  disabled: boolean;
}): React.JSX.Element {
  const text = formatValue(value);
  const isMissing = text === '—';

  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
          {attribute.label}
          {attribute.isRequired && (
            <span className="ml-1 text-danger" aria-hidden="true">
              *
            </span>
          )}
        </p>
        <p
          className={cx(
            'mt-1 whitespace-pre-wrap break-words text-sm',
            isMissing ? (attribute.isRequired ? 'text-danger' : 'text-ink-subtle') : 'text-ink',
          )}
        >
          {isMissing && attribute.isRequired ? 'Required, not answered' : text}
        </p>
      </div>
      <NoteButton disabled={disabled} label={attribute.label} onNote={onNote} />
    </li>
  );
}

/**
 * Print a stored answer.
 *
 * The shapes are the ones the wizard writes: a measurement is `{amount, unit}`,
 * a pack list is `[{name, quantity, unit}]`, a multi-select is an array of
 * strings. Anything else is a scalar. An unrecognised object is printed as JSON
 * rather than as "[object Object]" — a moderator seeing raw JSON knows
 * something is wrong with the field, which is true and useful.
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number' || typeof value === 'string') return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    return value
      .map((entry: unknown) => {
        if (entry !== null && typeof entry === 'object') {
          const row = entry as { name?: unknown; quantity?: unknown; unit?: unknown };
          if (row.name !== undefined) return scalarJoin([row.name, row.quantity, row.unit]);
          return JSON.stringify(entry);
        }
        return scalarText(entry);
      })
      .join(', ');
  }

  const measurement = value as { amount?: unknown; unit?: unknown };
  if (measurement.amount !== undefined) {
    return scalarJoin([measurement.amount, measurement.unit]);
  }

  return JSON.stringify(value);
}

/**
 * A stored value as text, never "[object Object]".
 *
 * Anything that is not a primitive is JSON here on purpose: a moderator seeing
 * raw JSON in a field knows something is wrong with that field, which is both
 * true and more use than a placeholder that hides it.
 */
function scalarText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

function scalarJoin(parts: unknown[]): string {
  return parts
    .map((part) => scalarText(part))
    .filter((part) => part.length > 0)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Notes and the decision
// ---------------------------------------------------------------------------

/**
 * Attach a note to one thing.
 *
 * A popover rather than a modal: a moderator writes six of these in a pass, and
 * six modals is six context switches away from the listing they are reading.
 */
function NoteButton({
  label,
  onNote,
  disabled,
}: {
  label: string;
  onNote: (message: string) => void;
  disabled: boolean;
}): React.JSX.Element | null {
  const [isOpen, setIsOpen] = useState(false);
  const [text, setText] = useState('');

  /*
   * Focused on open rather than with `autoFocus`. The attribute focuses on
   * mount wherever the element happens to be, which on a page this long would
   * yank a moderator's scroll position; this only fires because they just
   * pressed "Note" on this field.
   *
   * Stable, and it has to be: React reattaches an inline callback ref on every
   * render, so an inline arrow would focus this box again every time anything
   * re-rendered this row - including while the moderator is typing into the
   * note they opened on the photo below it.
   */
  const focusNote = useCallback((node: HTMLTextAreaElement | null) => {
    node?.focus();
  }, []);

  if (disabled) return null;

  return (
    /*
      The editor floats rather than sitting in the flow.

      A photo slot is a quarter of a column wide and a field row is already
      full; an editor taking space inline pushed the grid apart and clipped
      itself against the card. Anchored to the button's right edge it opens
      leftwards into space that is already there, which also means the layout
      behind it does not move while somebody is typing.
    */
    <div className="relative shrink-0">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen(!isOpen);
        }}
        className={cx(
          'rounded border px-2 py-1 text-xxs font-medium',
          isOpen
            ? 'border-brand bg-brand-soft text-brand'
            : 'border-border text-ink-muted hover:border-border-hover hover:text-ink',
        )}
      >
        Note
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-20 mt-1.5 w-64 space-y-2 rounded-lg border border-border bg-surface p-2 shadow-popover">
          <Textarea
            rows={3}
            ref={focusNote}
            value={text}
            aria-label={`Note about ${label}`}
            placeholder="What is wrong with it, and what would fix it."
            onChange={(event) => {
              setText(event.currentTarget.value);
            }}
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setText('');
              }}
              className="rounded px-2 py-1 text-xxs text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={text.trim().length === 0}
              onClick={() => {
                onNote(text.trim());
                setIsOpen(false);
                setText('');
              }}
              className="rounded bg-brand-fill px-2 py-1 text-xxs font-medium text-white disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What the seller already knows is wrong.
 *
 * Their own validation issues and any note a previous moderator left. Shown
 * before the decision panel because a listing that arrived with six open
 * blockers is usually a submission that should not have been possible, and that
 * is worth noticing before writing a seventh note.
 */
function OpenIssues({ listing }: { listing: ListingReviewDetail }): React.JSX.Element | null {
  if (listing.issues.length === 0 && listing.reviewComment === null) return null;

  return (
    <Card title="Already flagged" bodyClassName="px-5 py-4">
      {listing.reviewComment !== null && (
        <Callout tone="neutral" title="Last decision" className="mb-3">
          <p className="whitespace-pre-wrap text-sm">{listing.reviewComment}</p>
        </Callout>
      )}

      <ul className="space-y-2">
        {listing.issues.map((issue) => (
          <li key={issue.id} className="text-xs">
            <div className="flex items-center gap-2">
              <Badge tone={issue.severity === 'BLOCKER' ? 'danger' : 'warning'}>
                {issue.severity.toLowerCase()}
              </Badge>
              {issue.isFromModerator && <Badge tone="neutral">ours</Badge>}
            </div>
            <p className="mt-1 text-ink-muted">{issue.message}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function NotePanel({
  notes,
  onRemove,
  onDecide,
  disabled,
}: {
  notes: FieldNote[];
  onRemove: (index: number) => void;
  onDecide: (decision: Decision) => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <Card
      title="Your review"
      description={
        notes.length === 0
          ? 'Add a note beside anything that is wrong. They are sent together with the decision.'
          : `${String(notes.length)} ${notes.length === 1 ? 'note' : 'notes'} will go to the seller.`
      }
      bodyClassName="px-5 py-4"
    >
      {notes.length > 0 && (
        <ul className="mb-4 space-y-2">
          {notes.map((note, index) => (
            <li
              key={index}
              className="rounded-lg border border-border bg-surface-sunken px-3 py-2 text-xs"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
                  {note.attributeKey ?? note.section ?? 'General'}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onRemove(index);
                  }}
                  className="shrink-0 text-xxs text-ink-subtle hover:text-danger"
                >
                  Remove
                </button>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-ink">{note.message}</p>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2">
        <Button
          variant="primary"
          className="w-full"
          disabled={disabled}
          onClick={() => {
            onDecide('APPROVED');
          }}
        >
          Approve
        </Button>
        <Button
          className="w-full"
          disabled={disabled}
          onClick={() => {
            onDecide('ACTION_REQUIRED');
          }}
        >
          Send back for changes
        </Button>
        <Button
          variant="danger"
          className="w-full"
          disabled={disabled}
          onClick={() => {
            onDecide('REJECTED');
          }}
        >
          Reject
        </Button>
      </div>
    </Card>
  );
}

function DecisionDialog({
  listing,
  decision,
  notes,
  onClose,
}: {
  listing: ListingReviewDetail;
  decision: Decision;
  notes: FieldNote[];
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const client = useQueryClient();
  const navigate = useNavigate();

  const copy = DECISIONS[decision];
  const [comment, setComment] = useState('');

  /*
   * Notes are sent with every decision except approval.
   *
   * An approved listing with field notes attached would put blockers on a
   * listing that has just gone on sale, and the seller would open a live
   * product being told to fix it. If there is something to say on an approval,
   * it belongs in the comment.
   */
  const sentNotes = useMemo(() => (decision === 'APPROVED' ? [] : notes), [decision, notes]);

  const mutation = useMutation({
    mutationFn: () =>
      decideListing(listing.id, {
        status: decision,
        comment: comment.trim().length === 0 ? null : comment.trim(),
        /*
         * The revision this screen is showing.
         *
         * The server applies the decision only if the listing is still on it.
         * A queue two people share is a queue where one of them can be holding
         * a listing the seller has since replaced - and approving a revision
         * nobody read is the failure this one field exists to prevent.
         */
        expectedVersion: listing.submittedVersion,
        ...(sentNotes.length === 0
          ? {}
          : {
              fieldComments: sentNotes.map((note) => ({
                section: note.section,
                attributeKey: note.attributeKey,
                message: note.message,
              })),
            }),
      }),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ['admin', 'listing-review'] });
      toast.success(
        decision === 'APPROVED'
          ? result.offerId === null
            ? 'Approved.'
            : 'Approved. The seller can now put it on sale.'
          : decision === 'REJECTED'
            ? 'Rejected, and the seller has been told why.'
            : 'Sent back to the seller.',
      );
      onClose();
      void navigate('/listing-review');
    },
    onError: (error: unknown) => {
      toast.error(
        error instanceof ApiError ? error.message : 'That decision could not be recorded.',
      );
    },
  });

  const canSubmit = !copy.needsComment || comment.trim().length > 0;

  return (
    <Modal isOpen title={copy.title} onClose={onClose}>
      <div className="space-y-4">
        {decision === 'APPROVED' && (
          <Callout tone="success" title="What approving does">
            <p className="text-sm">
              This creates the product and the seller&apos;s offer. It does not put it on sale —
              that is the seller&apos;s own switch, because somebody who has waited three days for
              a review may not want it live at 2am with no stock behind it.
            </p>
          </Callout>
        )}

        {decision === 'APPROVED' && notes.length > 0 && (
          <Callout tone="warning" title={`${String(notes.length)} notes will not be sent`}>
            <p className="text-sm">
              Field notes go to a seller as things to fix, and a listing that has just been
              approved has nothing to fix. If any of it still needs saying, put it in the comment
              below — or send the listing back instead.
            </p>
          </Callout>
        )}

        {decision !== 'APPROVED' && (
          <Callout tone={decision === 'REJECTED' ? 'danger' : 'info'}>
            <p className="text-sm">
              {sentNotes.length === 0
                ? 'No field notes are attached. The seller will get only the comment below, which means they have to work out which field you mean.'
                : `${String(sentNotes.length)} field ${sentNotes.length === 1 ? 'note goes' : 'notes go'} with this, each beside the field it belongs to in the seller's own screen.`}
            </p>
          </Callout>
        )}

        <Field
          label={copy.needsComment ? 'What should the seller be told?' : 'Anything to tell them?'}
          hint="This goes on the seller's own screen. Write it for them, not for the file."
          required={copy.needsComment}
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={4}
              value={comment}
              placeholder={
                decision === 'ACTION_REQUIRED'
                  ? 'Three things need fixing before this can go on sale — see the notes on the fields themselves.'
                  : decision === 'REJECTED'
                    ? 'This is a medical device and the marketplace cannot list it without a CE marking and a notified body number.'
                    : ''
              }
              onChange={(event) => {
                setComment(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={copy.tone}
            isLoading={mutation.isPending}
            disabled={!canSubmit}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {copy.verb}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
