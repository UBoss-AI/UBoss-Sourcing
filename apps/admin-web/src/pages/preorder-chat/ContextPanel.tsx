/**
 * What a conversation is about, beside it.
 *
 * The product is shown TWICE on purpose: as the customer saw it when they
 * started (the snapshot, which never changes) and as it is now (a link to the
 * product in the catalogue). A rename or a withdrawal since is then visible
 * rather than silently rewriting what the customer asked about.
 *
 * Every control here names its permission; one the viewer lacks is not drawn.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { Badge, Button } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  assign,
  blockCustomer,
  fetchAssignees,
  fetchProposals,
  inboxKeys,
  linkPreorder,
  setTags,
  unblockCustomer,
  withdrawProposal,
  type ConversationDetail,
} from '@/lib/preorder-chats';
import { ProposalForm } from './ProposalForm';
import { ProposalSummary } from './ProposalSummary';

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-surface p-3 text-sm">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
      {children}
    </section>
  );
}

export function ContextPanel({
  conversation,
  onChanged,
  onOpenNotes,
}: {
  conversation: ConversationDetail;
  onChanged: () => void;
  /** Switch the conversation to its Internal notes tab. */
  onOpenNotes?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const canReply = can(Permission.PREORDER_CHAT_REPLY);
  const canAssign = can(Permission.PREORDER_CHAT_ASSIGN);
  const canModerate = can(Permission.PREORDER_CHAT_MODERATE);
  const canSeeCustomers = can(Permission.CUSTOMER_READ);
  const snapshot = conversation.context;

  const run = useMutation({ mutationFn: (task: () => Promise<unknown>) => task(), onSuccess: onChanged });
  const assignees = useQuery({ queryKey: inboxKeys.assignees, queryFn: fetchAssignees, enabled: canAssign });
  const proposals = useQuery({
    queryKey: inboxKeys.proposals(conversation.id),
    queryFn: () => fetchProposals(conversation.id),
  });

  const [tagText, setTagText] = useState(conversation.tags.join(', '));
  const [preorderId, setPreorderId] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const [showProposal, setShowProposal] = useState(false);

  const renamed = conversation.currentProduct !== null && snapshot !== null && conversation.currentProduct.name !== snapshot.product.name;
  const open = proposals.data?.proposals.find((proposal) => proposal.state === 'PROPOSED' && new Date(proposal.expiresAt) > new Date());

  return (
    <aside aria-label={t('preorderChats.contextLabel')} className="space-y-3">
      {run.isError && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
          {errorMessage(t, run.error)}
        </p>
      )}

      <Section title={t('preorderChats.ctx.product')}>
        {snapshot === null ? (
          <p className="text-ink-muted">—</p>
        ) : (
          <>
            <div className="flex gap-3">
              {snapshot.product.imageUrl !== null ? (
                <img src={snapshot.product.imageUrl} alt="" className="size-14 shrink-0 rounded object-cover" />
              ) : (
                <span aria-hidden="true" className="size-14 shrink-0 rounded bg-surface-sunken" />
              )}
              <div className="min-w-0">
                <p className="font-medium text-ink [overflow-wrap:anywhere]">{snapshot.product.name}</p>
                <p className="text-xs text-ink-muted">{t('preorderChats.ctx.sku', { sku: snapshot.variant?.sku ?? snapshot.product.sku })}</p>
                <p className="text-xs text-ink-muted">
                  {snapshot.variant === null ? t('preorderChats.ctx.noVariant') : t('preorderChats.ctx.variant', { name: snapshot.variant.name })}
                </p>
              </div>
            </div>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-ink-muted">{t('preorderChats.ctx.moq')}</dt>
              <dd>{snapshot.preorder.minimumBaseUnits === null ? '—' : formatNumber(snapshot.preorder.minimumBaseUnits)}</dd>
              <dt className="text-ink-muted">{t('preorderChats.ctx.unit')}</dt>
              <dd>{t(`preorderChats.unit.${snapshot.request.orderingUnit}` as TranslationKey)}</dd>
              <dt className="text-ink-muted">{t('preorderChats.ctx.quantity')}</dt>
              <dd>{snapshot.request.unitQuantity === null ? '—' : formatNumber(snapshot.request.unitQuantity)}</dd>
              <dt className="text-ink-muted">{t('preorderChats.ctx.pieces')}</dt>
              <dd>{snapshot.request.baseUnits === null ? '—' : formatNumber(snapshot.request.baseUnits)}</dd>
              <dt className="text-ink-muted">{t('preorderChats.ctx.date')}</dt>
              <dd>{snapshot.request.desiredDeliveryDate === null ? '—' : formatDate(snapshot.request.desiredDeliveryDate)}</dd>
            </dl>
            <p className="mt-2 text-[11px] text-ink-muted">{t('preorderChats.ctx.snapshotAt', { date: formatDateTime(snapshot.capturedAt) })}</p>
          </>
        )}
        {conversation.currentProduct !== null && (
          <p className="mt-2 text-xs">
            <Link to={`/products/${conversation.currentProduct.id}`} className="font-medium text-brand underline">
              {t('preorderChats.ctx.currentProduct')}
            </Link>{' '}
            {!conversation.currentProduct.isLive && <Badge tone="warning">{t('preorderChats.ctx.notLive')}</Badge>}
            {renamed && <span className="block text-ink-muted">{t('preorderChats.ctx.renamed', { name: conversation.currentProduct.name })}</span>}
          </p>
        )}
      </Section>

      {/* The offer on the table, if there is one: what the customer is being
          asked to review right now. */}
      <Section title={t('preorderChats.ctx.offer')}>
        {open === undefined ? (
          <p className="text-xs text-ink-muted">{t('preorderChats.ctx.offerNone')}</p>
        ) : (
          <ProposalSummary proposal={open} currency={conversation.pricingCurrency} />
        )}
      </Section>

      {onOpenNotes !== undefined && (
        <Section title={t('preorderChats.ctx.notes')}>
          <p className="text-xs text-ink-muted">{t('preorderChats.notesWarning')}</p>
          <Button size="sm" variant="ghost" className="mt-1" onClick={onOpenNotes}>
            {t('preorderChats.ctx.notesOpen')}
          </Button>
        </Section>
      )}

      <Section title={t('preorderChats.ctx.customer')}>
        <p className="font-medium text-ink">{conversation.customer.organization ?? '—'}</p>
        <p className="text-xs text-ink-muted">{conversation.customer.name ?? '—'}</p>
        {conversation.customer.email !== null && <p className="text-xs text-ink-muted [overflow-wrap:anywhere]">{conversation.customer.email}</p>}
        <p className="text-xs text-ink-muted">{t('preorderChats.ctx.language', { locale: conversation.customerLocale })}</p>
        {canSeeCustomers && (
          <Link to={`/customers/${conversation.customer.profileId}`} className="mt-1 inline-block text-xs font-medium text-brand underline">
            {t('preorderChats.ctx.openCustomer')}
          </Link>
        )}
        {conversation.block !== null && (
          <p className="mt-2 rounded-md bg-danger-soft px-2 py-1 text-xs text-ink">
            {t('preorderChats.ctx.blocked', { reason: conversation.block.reason })}
          </p>
        )}
        {canModerate &&
          (conversation.block !== null ? (
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => { run.mutate(() => unblockCustomer(conversation.id)); }}>
              {t('preorderChats.ctx.unblock')}
            </Button>
          ) : (
            <form
              className="mt-2 flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                run.mutate(() => blockCustomer(conversation.id, blockReason.trim()));
              }}
            >
              <label className="text-xs text-ink-muted">
                {t('preorderChats.ctx.blockReason')}
                <input value={blockReason} minLength={3} maxLength={500} required onChange={(event) => { setBlockReason(event.target.value); }} className="mt-0.5 block w-full rounded border border-border px-2 py-1 text-sm" />
              </label>
              <Button size="sm" type="submit" variant="secondary" disabled={blockReason.trim().length < 3}>
                {t('preorderChats.ctx.block')}
              </Button>
            </form>
          ))}
      </Section>

      <Section title={t('preorderChats.ctx.seller')}>
        <p className="text-ink">{conversation.seller.name ?? '—'}</p>
        <p className="text-[11px] text-ink-muted">{t('preorderChats.ctx.sellerNote')}</p>
        {conversation.seller.id !== null && canSeeCustomers && (
          <Link to={`/sellers/${conversation.seller.id}`} className="text-xs font-medium text-brand underline">
            {t('preorderChats.ctx.openSeller')}
          </Link>
        )}
      </Section>

      <Section title={t('preorderChats.ctx.assignment')}>
        <p className="text-xs text-ink">
          {conversation.assignedTo === null ? t('preorderChats.unassigned') : t('preorderChats.assignedTo', { email: conversation.assignedTo.email })}
        </p>
        {canAssign && assignees.data !== undefined && (
          <label className="mt-2 block text-xs text-ink-muted">
            {t('preorderChats.ctx.assignTo')}
            <select
              value={conversation.assignedTo?.id ?? ''}
              onChange={(event) => {
                const target = event.target.value === '' ? null : event.target.value;
                run.mutate(() => assign(conversation.id, target));
              }}
              className="mt-0.5 block w-full rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
            >
              <option value="">{t('preorderChats.unassigned')}</option>
              {assignees.data.assignees.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.email}
                </option>
              ))}
            </select>
          </label>
        )}
      </Section>

      {canReply && (
        <Section title={t('preorderChats.ctx.tags')}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const tags = tagText.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '');
              run.mutate(() => setTags(conversation.id, tags));
            }}
          >
            <label className="block text-xs text-ink-muted">
              {t('preorderChats.ctx.tagsHint')}
              <input value={tagText} onChange={(event) => { setTagText(event.target.value); }} className="mt-0.5 block w-full rounded border border-border px-2 py-1 text-sm" />
            </label>
            <Button size="sm" type="submit" variant="ghost" className="mt-1">
              {t('preorderChats.ctx.saveTags')}
            </Button>
          </form>
        </Section>
      )}

      <Section title={t('preorderChats.ctx.preorder')}>
        {conversation.preorder === null ? (
          <p className="text-xs text-ink-muted">{t('preorderChats.ctx.noPreorder')}</p>
        ) : (
          <div className="text-xs">
            <Link to={`/preorders/${conversation.preorder.id}`} className="font-medium text-brand underline">
              {conversation.preorder.requestNumber ?? conversation.preorder.id}
            </Link>
            {conversation.preorder.status !== null && <span className="ml-1 text-ink-muted">({conversation.preorder.status})</span>}
            <p className="mt-1 text-ink-muted">
              {conversation.preorderIsOperators === true ? t('preorderChats.ctx.operatorPreorder') : t('preorderChats.ctx.sellerPreorder')}
            </p>
          </div>
        )}
        {canReply && (
          <form
            className="mt-2 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              run.mutate(() => linkPreorder(conversation.id, preorderId.trim() === '' ? null : preorderId.trim().toUpperCase()));
            }}
          >
            <label className="text-xs text-ink-muted">
              {t('preorderChats.ctx.linkPreorder')}
              <input value={preorderId} maxLength={26} placeholder={t('preorderChats.ctx.preorderIdPlaceholder')} onChange={(event) => { setPreorderId(event.target.value); }} className="mt-0.5 block w-full rounded border border-border px-2 py-1 text-sm" />
            </label>
            <Button size="sm" type="submit" variant="ghost">
              {preorderId.trim() === '' && conversation.preorder !== null ? t('preorderChats.ctx.unlink') : t('preorderChats.ctx.link')}
            </Button>
          </form>
        )}
      </Section>

      <Section title={t('preorderChats.ctx.proposals')}>
        <p className="mb-2 text-[11px] text-ink-muted">{t('preorderChats.ctx.proposalsNote')}</p>
        <ul className="space-y-2">
          {proposals.data?.proposals.map((proposal) => (
            <li key={proposal.id} className="rounded border border-border-subtle p-2 text-xs">
              <p className="font-medium text-ink">
                {t('preorderChats.proposalRevision', { revision: String(proposal.revision) })} ·{' '}
                {t(`preorderChats.proposalState.${proposal.state}` as TranslationKey)}
              </p>
              <p className="text-ink-muted">
                {formatNumber(proposal.unitQuantity)} × {t(`preorderChats.unit.${proposal.orderingUnit}` as TranslationKey)} ={' '}
                {t('preorderChats.ctx.piecesValue', { pieces: formatNumber(proposal.equivalentBaseUnits) })} · {formatDate(proposal.deliveryDate)}
              </p>
              {proposal.preorderRequestId !== null && (
                <Link to={`/preorders/${proposal.preorderRequestId}`} className="text-brand underline">
                  {t('preorderChats.ctx.openPreorder')}
                </Link>
              )}
              {proposal.declineReason !== null && <p className="text-ink-muted">{t('preorderChats.ctx.declineReason', { reason: proposal.declineReason })}</p>}
              {canReply && proposal.id === open?.id && (
                <Button size="sm" variant="ghost" onClick={() => { run.mutate(() => withdrawProposal(conversation.id, proposal.id)); }}>
                  {t('preorderChats.ctx.withdraw')}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {canReply && !showProposal && (
          <Button size="sm" variant="primary" className="mt-2" onClick={() => { setShowProposal(true); }}>
            {open === undefined ? t('preorderChats.ctx.createProposal') : t('preorderChats.ctx.updateProposal')}
          </Button>
        )}
        {canReply && showProposal && (
          <ProposalForm
            conversation={conversation}
            onDone={() => {
              setShowProposal(false);
              void proposals.refetch();
              onChanged();
            }}
            onCancel={() => { setShowProposal(false); }}
          />
        )}
      </Section>
    </aside>
  );
}
