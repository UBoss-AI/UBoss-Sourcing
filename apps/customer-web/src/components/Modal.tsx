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
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { Button } from './ui';
import { cx } from '@/lib/cx';
import { lockPageScroll } from '@/lib/scroll-lock';
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
  /**
   * Where the dialog sits. `center` (the default) is every dialog in the app.
   * `anchored` is a popover: on a desktop it opens beside `anchorRef` - under
   * it, or above where there is no room below - and on a phone it becomes a
   * bottom sheet, because a popover beside a thumb-sized button on a 360px
   * screen covers the button and half the page. Either way it is still a
   * modal `<dialog>`: focus is trapped, Escape closes it, the page is inert.
   */
  placement?: 'center' | 'anchored';
  anchorRef?: RefObject<HTMLElement | null>;
}

/** Tailwind's `sm`: at and above it a popover, below it a sheet. */
const DESKTOP_QUERY = '(min-width: 640px)';
const GAP_PX = 8;
const EDGE_PX = 16;

function isDesktop(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP_QUERY).matches;
}

/**
 * Where an anchored dialog goes: under its anchor, right edges aligned, kept
 * inside the viewport; above the anchor when below would run off the bottom.
 */
function anchoredPosition(
  anchor: DOMRect,
  dialog: { width: number; height: number },
): CSSProperties | undefined {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  // An anchor scrolled out of sight is no place to point from: centre instead.
  if (anchor.bottom < 0 || anchor.top > viewportHeight) return undefined;
  const left = Math.min(
    Math.max(EDGE_PX, anchor.right - dialog.width),
    Math.max(EDGE_PX, viewportWidth - dialog.width - EDGE_PX),
  );
  const below = anchor.bottom + GAP_PX;
  const above = anchor.top - GAP_PX - dialog.height;
  const top =
    below + dialog.height <= viewportHeight - EDGE_PX || above < EDGE_PX
      ? Math.min(below, Math.max(EDGE_PX, viewportHeight - dialog.height - EDGE_PX))
      : above;
  return { margin: 0, position: 'fixed', top, left };
}

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  placement = 'center',
  anchorRef,
}: ModalProps): React.JSX.Element {
  const { t } = useI18n();
  const [anchoredStyle, setAnchoredStyle] = useState<CSSProperties | undefined>(undefined);

  const dialogRef = useRef<HTMLDialogElement>(null);
  // Generated, not the literal "modal-title" this used to hardcode. Two
  // dialogs mounted at once — a confirm raised from inside a form dialog, which
  // this app does — put the same id in the document twice, and `aria-labelledby`
  // then resolves to whichever the browser found first.
  const titleId = useId();
  const descriptionId = `${titleId}-description`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  // An anchored dialog is measured once it is open, and again on resize. The
  // page behind is scroll-locked, so the anchor cannot move any other way.
  useLayoutEffect(() => {
    if (!isOpen || placement !== 'anchored') return undefined;
    const place = (): void => {
      const dialog = dialogRef.current;
      const anchor = anchorRef?.current ?? null;
      if (dialog === null || anchor === null || !isDesktop()) {
        setAnchoredStyle(undefined);
        return;
      }
      // offsetWidth/offsetHeight, not getBoundingClientRect: the dialog is
      // mid scale-in animation here, and a transformed box measures small -
      // which put the bottom of a tall dialog off the screen.
      setAnchoredStyle(
        anchoredPosition(anchor.getBoundingClientRect(), {
          width: dialog.offsetWidth,
          height: dialog.offsetHeight,
        }),
      );
    };
    place();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
    };
  }, [isOpen, placement, anchorRef]);

  // The page behind holds still while this is open. See `lib/scroll-lock.ts`.
  useEffect(() => {
    if (!isOpen) return undefined;
    return lockPageScroll();
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
    // thing in this app that sits in front of everything else, and giving it
    // the same `shadow-popover` as an account menu said otherwise.
    //
    // The backdrop is tinted navy rather than neutral ink and carries a slight
    // blur, so the page behind reads as *set aside* rather than as merely
    // darkened. Both entrance animations are stripped by the reduced-motion
    // block in index.css.
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...(description === undefined ? {} : { 'aria-describedby': descriptionId })}
      style={anchoredStyle}
      className={cx(
        'w-full p-0',
        placement === 'anchored' ? 'sm:max-w-sm' : size === 'lg' ? 'max-w-3xl' : 'max-w-lg',
        // A bottom sheet on a phone: full width, sat on the bottom edge, square
        // at the bottom. Above `sm` the inline position above takes over.
        placement === 'anchored' &&
          'max-sm:mb-0 max-sm:mt-auto max-sm:max-w-none max-sm:rounded-b-none max-sm:border-b-0',
        // A column, capped to the viewport, with only the body scrolling.
        //
        // The body used to carry `max-h-[70vh]` on its own, which is fine
        // until the viewport is short: on a phone in landscape, 70vh of body
        // plus a header and a footer is taller than the screen, and what fell
        // off the bottom was the footer — the row with the confirm button in
        // it. `dvh` rather than `vh` so a mobile browser's collapsing toolbar
        // is counted rather than guessed at.
        'flex max-h-[calc(100dvh-2rem)] flex-col',
        // The browser styles a modal dialog `overflow: auto`. With the
        // header, body and footer a pixel or two taller than the cap (its
        // border), the dialog itself scrolled too - a second scrollbar beside
        // the body's. Only the body scrolls.
        'overflow-hidden',
        /*
         * A closed dialog is hidden. This line is not redundant.
         *
         * The browser's own stylesheet hides `dialog:not([open])` with
         * `display: none`, and the `flex` above — which this dialog needs for
         * its header/body/footer column — silently overrides it. The result is
         * that a `<Modal isOpen={false}>` renders *in the page flow*, as a
         * bordered white card with a title and a confirm button sitting in the
         * middle of whatever screen mounted it.
         *
         * Every caller in the app worked around this by mounting the Modal
         * only while open, with a comment saying why. That works and it is a
         * rule somebody will eventually not know about — `YourDataPanel`
         * already did not, and its erasure confirmation appeared inline at the
         * bottom of the profile page looking like an open dialog.
         *
         * `:not([open])` is specificity 0,2,0 against `.flex`'s 0,1,0, so it
         * wins; `showModal()` adds the attribute and `flex` takes over again.
         */
        '[&:not([open])]:hidden',
        'rounded-lg border border-border bg-surface text-ink shadow-overlay',
        'backdrop:bg-navy/50 backdrop:backdrop-blur-sm',
        'open:animate-dialog-in backdrop:animate-fade-in',
      )}
    >
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border-subtle px-4 py-5 sm:px-6 [@media(max-height:640px)]:py-3">
        <div className="min-w-0">
          <h2 id={titleId} className="text-title-sm text-ink">
            {title}
          </h2>
          {description !== undefined && (
            <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-ink-muted [@media(max-height:640px)]:line-clamp-2">
              {description}
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('modal.close')}>
          {t('modal.close')}
        </Button>
      </div>

      {/* `min-h-0` is what makes the cap above work: a flex child's default
          minimum is its content, so without it the body refuses to shrink and
          the dialog grows past the viewport again. */}
      <div className="min-h-0 flex-1 scroll-pane overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">{children}</div>

      {footer !== undefined && (
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border-subtle bg-surface-sunken px-4 py-4 sm:px-6">
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
