/**
 * A modal dialog.
 *
 * Built on the native `<dialog>` element, which gives focus trapping, the
 * top layer, and Escape-to-close for free. A hand-rolled div modal has to
 * reimplement all three, and the focus trap is the one everybody gets wrong -
 * tabbing out of a modal into the page behind it is how a keyboard user gets
 * stranded.
 *
 * `showModal()` also makes the rest of the page inert, so a screen reader
 * cannot wander out of the dialog either.
 */
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from './ui';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Wider dialog for a form with two columns. */
  size?: 'md' | 'lg';
}

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: ModalProps): React.JSX.Element {
  const { t } = useI18n();

  const dialogRef = useRef<HTMLDialogElement>(null);
  // Generated, not the literal "modal-title" this used to hardcode. Two
  // dialogs mounted at once — a confirm raised from inside a form dialog, which
  // this panel does — put the same id in the document twice, and
  // `aria-labelledby` then resolves to whichever the browser found first.
  const titleId = useId();
  const descriptionId = `${titleId}-description`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  // Escape fires `cancel`, and the browser closes the dialog without telling
  // React. Intercepting it keeps the component's state and the DOM in step.
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
    // `shadow-overlay`, the top of the elevation ladder: a dialog is the only
    // thing in this panel that sits in front of everything else, and giving it
    // the same `shadow-popover` as the account menu said otherwise.
    //
    // The backdrop is tinted navy rather than neutral ink and carries a slight
    // blur, so the table behind reads as *set aside* rather than as merely
    // darkened. Both entrance animations are stripped by the reduced-motion
    // block in index.css.
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...(description === undefined ? {} : { 'aria-describedby': descriptionId })}
      className={cx(
        'w-full p-0',
        size === 'lg' ? 'max-w-3xl' : 'max-w-lg',
        'rounded-lg border border-border bg-surface text-ink shadow-overlay',
        'backdrop:bg-navy/50 backdrop:backdrop-blur-sm',
        'open:animate-dialog-in backdrop:animate-fade-in',
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-title-xs text-ink">
            {title}
          </h2>
          {description !== undefined && (
            <p id={descriptionId} className="mt-0.5 text-xs leading-relaxed text-ink-muted">
              {description}
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('modal.close')}>
          {t('modal.close')}
        </Button>
      </div>

      <div className="max-h-[70vh] overflow-y-auto px-6 py-4">{children}</div>

      {footer !== undefined && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle bg-surface-sunken px-6 py-4">
          {footer}
        </div>
      )}
    </dialog>
  );
}

/**
 * Confirmation before something irreversible.
 *
 * The confirm button says what will happen ("Archive category"), never "OK" -
 * a dialog read out of context has to still be answerable.
 */
export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  isDangerous = false,
  isWorking = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  isDangerous?: boolean;
  isWorking?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose} disabled={isWorking}>
            {t('modal.cancel')}
          </Button>
          <Button
            variant={isDangerous ? 'danger' : 'primary'}
            onClick={onConfirm}
            isLoading={isWorking}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-ink-muted">{body}</div>
    </Modal>
  );
}
