/**
 * The chat, over the product page: a drawer on the right on a desktop, the
 * whole screen on a phone.
 *
 * A native modal `<dialog>`, like every dialog here, so focus is trapped
 * inside it, Escape closes it and the page behind is inert - and focus goes
 * back to the button that opened it. `100dvh` so a phone's collapsing toolbar
 * and on-screen keyboard are measured rather than guessed, which is what keeps
 * the composer from disappearing under the keyboard.
 */
import { useEffect, useId, useRef } from 'react';
import { CloseIcon } from '@/components/icons';
import { useI18n } from '@/i18n/i18n-context';
import { lockPageScroll } from '@/lib/scroll-lock';
import type { ChatContextInput } from '@/lib/preorder-chat';
import { ChatThread } from './ChatThread';

export function PreorderChatDrawer({
  isOpen,
  onClose,
  conversationId,
  context,
  onContextChange,
  onConversation,
  onReviewProposal,
}: {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string | null;
  context: ChatContextInput;
  onContextChange: (next: ChatContextInput) => void;
  onConversation: (conversationId: string) => void;
  onReviewProposal: (conversationId: string, proposalId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    return lockPageScroll();
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const onCancel = (event: Event): void => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
    };
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className={
        // Hidden when closed: `flex` would otherwise override the browser's
        // own display:none for a closed dialog (see components/Modal.tsx).
        'fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none flex-col border-0 bg-surface p-0 text-ink ' +
        'backdrop:bg-navy/50 backdrop:backdrop-blur-sm [&:not([open])]:hidden open:flex ' +
        'sm:left-auto sm:right-0 sm:w-[28rem] sm:border-l sm:border-border sm:shadow-overlay'
      }
    >
      {isOpen && (
        <>
          <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 id={titleId} className="text-base font-semibold text-ink">
              {t('preorderChat.title')}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('preorderChat.close')}
              className="inline-flex size-9 items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <CloseIcon className="size-5" />
            </button>
          </header>
          <ChatThread
            conversationId={conversationId}
            context={context}
            onContextChange={onContextChange}
            onConversation={onConversation}
            onReviewProposal={onReviewProposal}
            active={isOpen}
          />
        </>
      )}
    </dialog>
  );
}
