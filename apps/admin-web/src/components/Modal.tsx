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
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from './ui';

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
  const dialogRef = useRef<HTMLDialogElement>(null);

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
    <dialog
      ref={dialogRef}
      aria-labelledby="modal-title"
      className={`w-full ${size === 'lg' ? 'max-w-3xl' : 'max-w-lg'} rounded-lg border border-border bg-surface p-0 text-ink shadow-popover backdrop:bg-ink/40`}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3.5">
        <div>
          <h2 id="modal-title" className="text-sm font-semibold text-ink">
            {title}
          </h2>
          {description !== undefined && (
            <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          Close
        </Button>
      </div>

      <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>

      {footer !== undefined && (
        <div className="flex justify-end gap-2 border-t border-border bg-surface-sunken px-5 py-3">
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
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose} disabled={isWorking}>
            Cancel
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
