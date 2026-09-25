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
import { Button } from '@/components/ui';
import { CloseIcon, ShieldIcon } from '@/components/icons';
import { useI18n } from '@/i18n/i18n-context';
import { lockPageScroll } from '@/lib/scroll-lock';
import type { ChatContextInput } from '@/lib/preorder-chat';
import { rememberHandoffIntent } from '@/lib/preorder-assistant';
import { usePreorderAssistant } from '@/lib/use-preorder-assistant';
import { ChatThread } from './ChatThread';
import { PreorderAssistant } from './PreorderAssistant';

export function PreorderChatDrawer({
  isOpen,
  onClose,
  signedIn = true,
  onSignIn,
  conversationId,
  context,
  onContextChange,
  onConversation,
  onReviewProposal,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** A guest sees the assistant only; writing or asking for a person signs them in. */
  signedIn?: boolean;
  onSignIn?: () => void;
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
          {signedIn ? (
            <ChatThread
              conversationId={conversationId}
              context={context}
              onContextChange={onContextChange}
              onConversation={onConversation}
              onReviewProposal={onReviewProposal}
              active={isOpen}
            />
          ) : (
            <GuestAssistant context={context} onSignIn={onSignIn ?? onClose} />
          )}
        </>
      )}
    </dialog>
  );
}

/**
 * The drawer for somebody not signed in: the assistant, and a way to the team
 * through sign-in. No socket, no conversation, nothing about the guest sent
 * anywhere - the assistant's answers are the product's public information.
 */
function GuestAssistant({
  context,
  onSignIn,
}: {
  context: ChatContextInput;
  onSignIn: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const assistant = usePreorderAssistant({ context, enabled: true, signedIn: false });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-3xl px-3 py-3 sm:px-4">
          <PreorderAssistant
            assistant={assistant}
            productName=""
            signedIn={false}
            handoffStatus="idle"
            handoffError={null}
            onRequestHuman={() => {
              // Finished for them once they are back: the answers wait in
              // this tab, and so does the request.
              rememberHandoffIntent({ productId: context.productId, variantId: context.variantId, topic: assistant.topic });
              onSignIn();
            }}
          />
        </div>
      </div>
      <div className="shrink-0 border-t border-border-subtle bg-surface px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2.5 sm:px-4">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 flex-1 text-xs text-ink-muted">{t('preorderChat.assistant.guestFooter')}</p>
          <Button size="sm" onClick={onSignIn}>
            {t('preorderChat.assistant.signInToWrite')}
          </Button>
        </div>
        <p className="mx-auto mt-1.5 flex w-full max-w-3xl items-start gap-1.5 text-xxs leading-snug text-ink-subtle">
          <ShieldIcon className="mt-px size-3.5 shrink-0" />
          <span className="[@media(max-height:760px)]:line-clamp-1">{t('preorderChat.safety')}</span>
        </p>
      </div>
    </div>
  );
}
