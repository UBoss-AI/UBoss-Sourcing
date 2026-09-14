/**
 * Brand requests — the operator deciding which names may be sold under.
 *
 * A seller who cannot find their brand in the listing wizard asks for it, and
 * the brand row is created straight away as PENDING so they can carry on with
 * the rest of the listing. Nothing on an unapproved name can go on sale, so
 * every request sitting here is at least one listing that cannot be bought.
 * That is why the queue is oldest-first and why each card states how many
 * listings are held up behind it.
 *
 * Cards rather than a table. The justification — why this seller says they are
 * entitled to sell the brand — is free text a reviewer has to read to decide,
 * and a table cell is the wrong shape for a paragraph.
 *
 * The one thing this screen must not let somebody forget: **a brand is one
 * row, not one row per seller.** Two sellers asking for "B. Braun" attach to
 * the same brand, so approving is a decision about the name and not about the
 * business in front of you. Where that is the case the card says so, by name.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Textarea,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { decideBrandRequest, fetchBrandRequests, type BrandRequestRow } from '@/lib/sellers';

type Decision = 'APPROVED' | 'INFORMATION_REQUESTED' | 'REJECTED';

/**
 * What each decision is called, and whether it may be taken silently.
 *
 * A refusal and a question both need a reason, because both land on the
 * seller's own screen and "rejected" with nothing beside it is a dead end they
 * cannot act on. An approval does not: the brand appearing is the message.
 */
const DECISIONS: Record<
  Decision,
  { title: string; verb: string; tone: 'primary' | 'danger'; needsReason: boolean }
> = {
  APPROVED: { title: 'Approve this brand', verb: 'Approve', tone: 'primary', needsReason: false },
  INFORMATION_REQUESTED: {
    title: 'Ask the seller for more',
    verb: 'Send the question',
    tone: 'primary',
    needsReason: true,
  },
  REJECTED: { title: 'Refuse this brand', verb: 'Refuse', tone: 'danger', needsReason: true },
};

export function BrandRequestsPage(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin', 'brand-requests'],
    queryFn: fetchBrandRequests,
  });

  const [deciding, setDeciding] = useState<{ row: BrandRequestRow; decision: Decision } | null>(
    null,
  );

  const requests = query.data?.requests ?? [];
  const waiting = requests.filter((row) => row.status === 'PENDING').length;
  const listingsHeld = requests.reduce((total, row) => total + row.listingsWaiting, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Brand requests"
        description={
          requests.length === 0
            ? 'Names sellers have asked to list under.'
            : `${String(waiting)} waiting for a decision` +
              (listingsHeld > 0
                ? `, holding up ${String(listingsHeld)} ${listingsHeld === 1 ? 'listing' : 'listings'}.`
                : '.')
        }
      />

      {query.isPending && <LoadingState label="Loading brand requests" />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.isSuccess && requests.length === 0 && (
        <EmptyState
          title="Nothing waiting"
          description="When a seller cannot find their brand in the listing wizard, the name they ask for appears here."
        />
      )}

      {requests.length > 0 && (
        <ul className="space-y-4">
          {requests.map((row) => (
            <li key={row.id}>
              <RequestCard
                row={row}
                onDecide={(decision) => {
                  setDeciding({ row, decision });
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {deciding !== null && (
        <DecisionDialog
          row={deciding.row}
          decision={deciding.decision}
          onClose={() => {
            setDeciding(null);
          }}
        />
      )}
    </div>
  );
}

function RequestCard({
  row,
  onDecide,
}: {
  row: BrandRequestRow;
  onDecide: (decision: Decision) => void;
}): React.JSX.Element {
  const isWaitingOnSeller = row.status === 'INFORMATION_REQUESTED';

  return (
    <Card
      title={row.requestedName}
      description={`Asked by ${row.sellerName} · ${formatRelative(row.createdAt)}`}
      actions={
        <div className="flex items-center gap-2">
          {row.listingsWaiting > 0 && (
            <Badge tone="warning" dot>
              {row.listingsWaiting} {row.listingsWaiting === 1 ? 'listing' : 'listings'} waiting
            </Badge>
          )}
          <Badge tone={isWaitingOnSeller ? 'neutral' : 'brand'} dot>
            {isWaitingOnSeller ? 'Asked the seller' : 'Waiting for a decision'}
          </Badge>
        </div>
      }
      bodyClassName="px-5 py-4"
    >
      <div className="space-y-4">
        {/*
          The shared-brand warning goes first, above everything a reviewer
          would otherwise decide on. A brand is one row: approving this name
          approves it for every seller attached to it, and finding that out
          afterwards is finding it out too late.
        */}
        {row.alsoRequestedBy.length > 0 && (
          <Callout tone="info" title="This name is not only theirs">
            <p className="text-sm">
              {row.alsoRequestedBy.length === 1
                ? `${row.alsoRequestedBy[0] ?? ''} has also asked for it.`
                : `${row.alsoRequestedBy.join(', ')} have also asked for it.`}{' '}
              A brand is one entry in the catalogue, so approving it here lets all of them list
              under the name — and refusing it does not stop the others, whose requests stay in
              this queue.
            </p>
          </Callout>
        )}

        {isWaitingOnSeller && (
          <Callout tone="warning" title="You have already gone back to them">
            <p className="whitespace-pre-wrap text-sm">
              {row.informationRequested ?? 'No question was recorded.'}
            </p>
          </Callout>
        )}

        <dl className="grid gap-4 sm:grid-cols-2">
          <Detail label="Manufacturer" value={row.manufacturerLegalName} />
          <Detail label="Website" value={row.websiteUrl} isLink />
        </dl>

        <div>
          <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
            Why they say they may sell it
          </dt>
          <dd className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink">
            {row.justification === null || row.justification.length === 0 ? (
              <span className="text-ink-subtle">Nothing was given.</span>
            ) : (
              row.justification
            )}
          </dd>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle pt-4">
          <Button
            variant="danger"
            onClick={() => {
              onDecide('REJECTED');
            }}
          >
            Refuse
          </Button>
          <Button
            onClick={() => {
              onDecide('INFORMATION_REQUESTED');
            }}
          >
            Ask for more
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onDecide('APPROVED');
            }}
          >
            Approve
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * One labelled fact.
 *
 * A website is the field a reviewer actually follows, so it is a link — but a
 * seller typed it, which is why it opens in its own tab with the opener
 * detached. `noreferrer` implies `noopener`; both are spelled out because the
 * pair is what stops the new tab reaching back into the panel.
 */
function Detail({
  label,
  value,
  isLink = false,
}: {
  label: string;
  value: string | null;
  isLink?: boolean;
}): React.JSX.Element {
  const isSafeLink =
    isLink && value !== null && (value.startsWith('https://') || value.startsWith('http://'));

  return (
    <div className="min-w-0">
      <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className="mt-1 break-words text-sm text-ink">
        {value === null || value.length === 0 ? (
          <span className="text-ink-subtle">Not given</span>
        ) : isSafeLink ? (
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand hover:underline"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function DecisionDialog({
  row,
  decision,
  onClose,
}: {
  row: BrandRequestRow;
  decision: Decision;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const client = useQueryClient();

  const copy = DECISIONS[decision];

  const [reason, setReason] = useState('');
  /**
   * The spelling it is approved under.
   *
   * Prefilled with what the seller typed, so the common case is leaving it
   * alone. The point of it being editable is the near miss — "Brawn" for
   * "B. Braun" — where refusing sends the seller round the loop again to type
   * a name we could have corrected in a second.
   */
  const [name, setName] = useState(row.requestedName);

  const renamed = decision === 'APPROVED' && name.trim() !== row.requestedName;

  const mutation = useMutation({
    mutationFn: () =>
      decideBrandRequest(row.id, {
        decision,
        reason: reason.trim().length === 0 ? null : reason.trim(),
        correctedName: renamed ? name.trim() : null,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'brand-requests'] });
      toast.success(
        decision === 'APPROVED'
          ? `${renamed ? name.trim() : row.requestedName} is now in the catalogue.`
          : decision === 'REJECTED'
            ? `${row.requestedName} was refused.`
            : `${row.sellerName} has been asked for more.`,
      );
      onClose();
    },
    onError: (error: unknown) => {
      // The server's own sentence where there is one. It knows why it refused,
      // and "somebody else has already decided this" in particular has to say
      // so rather than read as a network failure.
      toast.error(
        error instanceof ApiError ? error.message : 'That decision could not be recorded.',
      );
    },
  });

  const canSubmit =
    (!copy.needsReason || reason.trim().length > 0) &&
    (decision !== 'APPROVED' || name.trim().length >= 2);

  return (
    <Modal isOpen title={copy.title} onClose={onClose}>
      <div className="space-y-4">
        {decision === 'APPROVED' && (
          <Callout tone="success" title="What approving does">
            <p className="text-sm">
              The name goes into the catalogue and can be used immediately.
              {row.listingsWaiting > 0
                ? ` ${String(row.listingsWaiting)} ${row.listingsWaiting === 1 ? 'listing that was' : 'listings that were'} held up behind it can now be submitted for review.`
                : ''}{' '}
              It does not publish anything on its own — each listing still goes through quality
              review.
            </p>
          </Callout>
        )}

        {decision === 'REJECTED' && (
          <Callout tone="warning" title="What refusing does">
            <p className="text-sm">
              {row.sellerName} cannot list under this name, and any draft carrying it stays
              unpublishable.
              {row.alsoRequestedBy.length > 0
                ? ' The name itself stays in the queue, because another seller has asked for it too and this decision is not theirs.'
                : ' The name is retired with it.'}
            </p>
          </Callout>
        )}

        {decision === 'APPROVED' && (
          <Field
            label="Approve it under this name"
            hint="Correct a misspelling here rather than refusing it. This is the spelling every seller will see and search."
            required
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={name}
                onChange={(event) => {
                  setName(event.currentTarget.value);
                }}
              />
            )}
          </Field>
        )}

        {renamed && (
          <Callout tone="info">
            <p className="text-sm">
              {row.sellerName} asked for <strong>{row.requestedName}</strong>. It will be added as{' '}
              <strong>{name.trim()}</strong>, and what they typed is kept on the record.
            </p>
          </Callout>
        )}

        <Field
          label={copy.needsReason ? 'What should the seller be told?' : 'Anything to tell them?'}
          hint="This goes on the seller's own screen. Write it for them, not for the file."
          required={copy.needsReason}
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={4}
              value={reason}
              placeholder={
                decision === 'INFORMATION_REQUESTED'
                  ? 'Please send the distribution agreement that names your business, or a link to a page on the manufacturer’s own site listing you as a distributor.'
                  : decision === 'REJECTED'
                    ? 'This is the name of a product range rather than a brand. List it under the manufacturer’s own name instead.'
                    : ''
              }
              onChange={(event) => {
                setReason(event.currentTarget.value);
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
