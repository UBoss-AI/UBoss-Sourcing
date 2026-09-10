/**
 * The AI Mode conversation list.
 *
 * A rail on a wide screen and a drawer on a narrow one — the same component
 * either way, because a second implementation of a list with rename and delete
 * on it is how the two stop agreeing about what "selected" looks like.
 *
 * The threads come from the API, not from this browser. That is the difference
 * between AI Mode and the corner widget it replaces: the widget kept one
 * conversation id in `sessionStorage` and forgot everything when the tab
 * closed. Here the history belongs to the account, so it is on whichever
 * machine the customer signs in from — and it is only ever theirs, because
 * every read on the API is scoped to the caller's own profile.
 *
 * Delete asks first. It is a soft delete on the server — the transcript
 * survives for staff and for the retention sweep — but from the customer's
 * side it is gone for good, and a one-click "gone for good" next to a rename
 * button is a mis-click waiting to happen.
 */
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/Modal';
import { Button, ButtonLink, Spinner } from '@/components/ui';
import {
  CloseIcon,
  PencilIcon,
  PlusIcon,
  SignOutIcon,
  SparkIcon,
  TrashIcon,
} from '@/components/icons';
import { cx } from '@/lib/cx';
import { AI_MODE_PATH } from '@/lib/ai-mode';
import { conversationLabel } from './conversations';
import type { ConversationSummary } from './conversations';
import { useI18n } from '@/i18n/i18n-context';

function RenameRow({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus and select, so renaming "Cannula sizes" to something else does not
  // start with the customer clearing the box by hand.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <form
      className="px-1.5 py-1"
      onSubmit={(event) => {
        event.preventDefault();
        onCommit(value);
      }}
    >
      <label htmlFor="ai-rename" className="sr-only">
        {t('aiMode.renameLabel')}
      </label>
      <input
        id="ai-rename"
        ref={inputRef}
        value={value}
        maxLength={120}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        onBlur={() => {
          onCommit(value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        className="w-full rounded-md border border-brand bg-surface px-2.5 py-1.5 text-sm text-ink outline-none"
      />
    </form>
  );
}

export function AiSidebar({
  conversations,
  isLoading,
  activeId,
  onSelect,
  onNewChat,
  onRename,
  onDelete,
  onCollapse,
  onSignOut,
  customerName,
  isSignedIn,
}: {
  conversations: ConversationSummary[];
  isLoading: boolean;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /** Hides the rail on desktop, closes the drawer on mobile. */
  onCollapse: () => void;
  onSignOut: () => void;
  customerName: string | null;
  /**
   * Whether there is an account behind this visit.
   *
   * A guest may chat, but a history is a thing an account has — so instead of
   * an empty list and a Sign out button they cannot use, the rail says what
   * signing in would add. It is an invitation, never a wall: the composer on
   * the right works either way.
   */
  isSignedIn: boolean;
}): React.JSX.Element {
  const { t } = useI18n();

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-sunken">
      {/* --- Head ----------------------------------------------------------- */}
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-3.5">
        <p className="flex min-w-0 items-center gap-2 text-title-xs text-ink">
          <SparkIcon className="h-[1.15rem] w-[1.15rem] shrink-0 text-brand" />
          <span className="truncate">{t('aiMode.title')}</span>
        </p>
        <button
          type="button"
          onClick={onCollapse}
          aria-label={t('aiMode.hideSidebar')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="px-3 pb-3">
        <Button variant="secondary" fullWidth onClick={onNewChat}>
          <PlusIcon className="h-4 w-4" />
          {t('aiMode.newChat')}
        </Button>
      </div>

      {/* --- History --------------------------------------------------------
       *
       * A guest gets an invitation in place of the list. Not a wall, and not a
       * greyed-out one either: what is missing for them is genuinely a feature
       * of having an account, so the rail says so and the composer carries on
       * working.
       */}
      {!isSignedIn ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          <p className="text-xxs font-semibold uppercase tracking-[0.14em] text-ink-subtle">
            {t('aiMode.history')}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-ink-muted">
            {t('aiMode.guestHistoryNote')}
          </p>
          <ButtonLink
            to="/login"
            state={{ from: AI_MODE_PATH }}
            variant="secondary"
            size="sm"
            fullWidth
            className="mt-3"
          >
            {t('aiMode.signIn')}
          </ButtonLink>
        </div>
      ) : (
        <>
          <p className="shrink-0 px-4 pb-1.5 pt-2 text-xxs font-semibold uppercase tracking-[0.14em] text-ink-subtle">
            {t('aiMode.history')}
          </p>

          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
            {isLoading && (
              <div className="flex items-center gap-2 px-2.5 py-3 text-xs text-ink-muted">
                <Spinner className="h-3.5 w-3.5" />
                {t('aiMode.loadingHistory')}
              </div>
            )}

            {!isLoading && conversations.length === 0 && (
              <p className="px-2.5 py-3 text-xs leading-relaxed text-ink-muted">
                {t('aiMode.historyEmpty')}
              </p>
            )}

            <ul>
              {conversations.map((conversation) => {
                const isActive = conversation.id === activeId;
                const label = conversationLabel(conversation, t('aiMode.untitled'));

                if (renamingId === conversation.id) {
                  return (
                    <li key={conversation.id}>
                      <RenameRow
                        initial={conversation.title ?? label}
                        onCommit={(title) => {
                          setRenamingId(null);
                          if (title.trim() !== (conversation.title ?? '').trim()) {
                            onRename(conversation.id, title.trim());
                          }
                        }}
                        onCancel={() => {
                          setRenamingId(null);
                        }}
                      />
                    </li>
                  );
                }

                return (
                  /*
                   * `group` on the row and the two actions revealed on hover — but
                   * `focus-within:opacity-100` as well, or the rename and delete
                   * buttons are invisible to a keyboard user who has just tabbed
                   * onto them. That is the standard bug in every hover-revealed
                   * action row.
                   */
                  <li key={conversation.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(conversation.id);
                      }}
                      aria-current={isActive ? 'true' : undefined}
                      className={cx(
                        'block w-full truncate rounded-md py-2 pl-2.5 pr-16 text-left text-sm transition-colors',
                        isActive
                          ? 'bg-brand-soft font-medium text-brand'
                          : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                      )}
                    >
                      {label}
                    </button>

                    <span className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => {
                          setRenamingId(conversation.id);
                        }}
                        aria-label={t('aiMode.renameNamed', { name: label })}
                        className="flex h-7 w-7 items-center justify-center rounded text-ink-subtle transition-colors hover:bg-surface hover:text-ink"
                      >
                        <PencilIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPendingDelete(conversation);
                        }}
                        aria-label={t('aiMode.deleteNamed', { name: label })}
                        className="flex h-7 w-7 items-center justify-center rounded text-ink-subtle transition-colors hover:bg-surface hover:text-danger"
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}

      {/* --- Account --------------------------------------------------------
       *
       * Only for somebody who has one. Offering Sign out to a guest is the
       * classic way an interface announces that it has not read the session.
       */}
      {isSignedIn && (
        <div className="shrink-0 border-t border-border px-3 py-3">
          {customerName !== null && (
            <p className="mb-2 truncate px-1 text-xs font-medium text-ink" title={customerName}>
              {customerName}
            </p>
          )}
          <Button variant="ghost" size="sm" fullWidth onClick={onSignOut}>
            <SignOutIcon className="h-4 w-4" />
            {t('aiMode.signOut')}
          </Button>
        </div>
      )}

      {/* Mounted only while there is something to confirm — see the note on
          the image dialog in `HeroSearch`. */}
      {pendingDelete !== null && (
        <ConfirmDialog
          isOpen
          onClose={() => {
            setPendingDelete(null);
          }}
          onConfirm={() => {
            onDelete(pendingDelete.id);
            setPendingDelete(null);
          }}
          title={t('aiMode.deleteTitle')}
          body={t('aiMode.deleteBody', {
            name: conversationLabel(pendingDelete, t('aiMode.untitled')),
          })}
          confirmLabel={t('aiMode.deleteConfirm')}
          isDangerous
        />
      )}
    </div>
  );
}
