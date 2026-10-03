/**
 * "Add instructions" — say what you need, without buying anything.
 *
 * The basket has had a box for this per line for a while. It only exists once
 * the product is in a basket, though, and it only reaches a seller if that
 * basket becomes an order — which is too late for the things a trade buyer
 * most wants to say. "Do you do this in 8mm?" "Can you supply it with a
 * calibration certificate?" "We need four hundred a month, would you hold
 * stock?" Each of those decides whether there is an order at all, and until
 * this control there was nowhere on the product to put them.
 *
 * ## Where it lives, and where it does not
 *
 * On the **product page**, directly under the row of Add to Cart, Schedule
 * your Cart and Preorder. It belongs with those three because it is an
 * alternative to pressing them rather than something you do afterwards: the
 * shopper reading that panel has the specification in front of them, and the
 * thing stopping them is a question they will only ask if asking is offered
 * where the decision is being made. It takes `variant="secondary"` there — the
 * three filled buttons are the ways to buy, and this is not one.
 *
 * Pressing it opens a small panel right under it rather than a modal: up to
 * 500 characters, a running count, Save and Cancel. See `InstructionPanel`.
 *
 * **Not on `ProductCard`.** It was there briefly and came off again. A card is
 * a stretched link — an `::after` overlay on the product name makes the whole
 * tile follow one anchor — so a real control on it has to be lifted above that
 * overlay and stop the click bubbling. That works, and it still puts a second
 * thing to press on a tile whose entire design is that there is exactly one.
 * On a grid the card's job is to be compared and then opened.
 *
 * The click handler keeps `preventDefault` and `stopPropagation` anyway. They
 * cost nothing, and they are what makes this safe to drop into a row, a list
 * item or anything else that is itself clickable.
 *
 * ## Why a guest is sent to sign in rather than shown the box
 *
 * A seller reading these needs to know whether three sentences came from three
 * buyers or from one, and whether the buyer asking for four hundred a month is
 * one they already supply. An anonymous line answers neither, and an anonymous
 * box is a flood with no way to stop it. The purchase is not the gate — an
 * account is, and the sign-in returns to where the shopper was.
 *
 * ## Why the existing instruction is loaded before the box opens
 *
 * There is one standing instruction per shopper per product, and saving
 * replaces it. A form that came up empty over something they wrote last week
 * would have them write it again, and the second one would silently overwrite
 * the first. So the panel opens in a loading state and fills with their own
 * words, which also turns "Add" into "Edit" on the button itself.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Spinner, Textarea } from './ui';
import { useToast } from './toast-context';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import {
  MAX_INSTRUCTION_CHARS,
  fetchOwnInstruction,
  instructionQueryKey,
  saveOwnInstruction,
} from '@/lib/product-instructions';

export interface ProductInstructionsButtonProps {
  productId: string;
  /** For the panel's intro, so it is obvious what is being written about. */
  productName: string;
  /** The version chosen, where one is. Null means the product in general. */
  variantId?: string | null;
  /** `lg` beside the buy buttons, so the row sits on one baseline. */
  size?: 'sm' | 'md' | 'lg';
  /**
   * How loud it is.
   *
   * `secondary` under the buy row, where it is a real option and has to look
   * like one without competing with the commitments. `ghost` is the default
   * for anywhere quieter.
   */
  variant?: 'secondary' | 'ghost';
  fullWidth?: boolean;
  className?: string;
}

export function ProductInstructionsButton({
  productId,
  productName,
  variantId = null,
  size = 'md',
  variant = 'ghost',
  fullWidth = false,
  className,
}: ProductInstructionsButtonProps): React.JSX.Element {
  const { t } = useI18n();
  const { isCustomer } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const [isOpen, setIsOpen] = useState(false);

  /*
   * Only asked for once somebody is signed in.
   *
   * A guest has no instruction by definition, so asking would be a 401 for an
   * answer that is knowable without the request. The button still renders —
   * the point is that the offer is visible before the account is, or nobody
   * finds out the feature exists.
   */
  const existing = useQuery({
    queryKey: instructionQueryKey(productId, variantId),
    queryFn: () => fetchOwnInstruction(productId, variantId),
    enabled: isCustomer,
    // These change only when this shopper changes them, from a panel that
    // writes the result straight back into this cache. Re-asking on every
    // window focus would be a request for an answer that cannot have moved.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const stored = existing.data ?? null;
  const hasInstruction = stored !== null;

  // A different option is a different instruction: close rather than let a
  // draft written about one size be saved against another.
  useEffect(() => {
    setIsOpen(false);
  }, [productId, variantId]);

  const close = (): void => {
    setIsOpen(false);
    // Back to the control that opened it, once the panel has left the DOM.
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  return (
    <div className="min-w-0">
      <Button
        ref={triggerRef}
        size={size}
        variant={variant}
        fullWidth={fullWidth}
        className={className}
        aria-expanded={isCustomer ? isOpen : undefined}
        aria-controls={isCustomer && isOpen ? panelId : undefined}
        onClick={(event) => {
          // Neither is needed where this sits today, and both are kept: they
          // are what makes the control safe to drop into a row, a list item or
          // anything else that is itself clickable. See the header.
          event.preventDefault();
          event.stopPropagation();

          if (!isCustomer) {
            /*
             * Sign in, then come back to exactly this page.
             *
             * `next` is the path this shopper is standing on, read at the
             * moment of the press rather than derived from the product. That
             * is the same URL wherever this button is used, and it is the one
             * thing a shopper signing in mid-thought expects to get back —
             * including the query string, which on a product page carries the
             * colour and size they had already chosen.
             */
            void navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
            return;
          }

          if (isOpen) close();
          else setIsOpen(true);
        }}
      >
        <PencilIcon />
        {hasInstruction ? t('instructions.editInstructions') : t('instructions.addInstructions')}
      </Button>

      {isOpen && (
        <InstructionPanel
          id={panelId}
          productId={productId}
          productName={productName}
          variantId={variantId}
          existing={stored}
          isLoading={existing.isPending}
          onClose={close}
        />
      )}
    </div>
  );
}

/**
 * The box itself, directly under the control that opened it.
 *
 * An inline panel rather than a modal: it is a few lines about the product the
 * shopper is looking at, and covering that product to write them took away
 * the thing they were writing about. It is still a dialog to assistive
 * technology — named by its heading, closed by Escape, focus moved into the
 * box on open and back to the control on close — just not a modal one, so the
 * page around it stays readable.
 *
 * Mounted only while open, so the draft starts from what is stored every time.
 * That is what makes Cancel a restore: closing throws the draft away, and the
 * next open shows what is actually saved.
 */
function InstructionPanel({
  id,
  productId,
  productName,
  variantId,
  existing,
  isLoading,
  onClose,
}: {
  id: string;
  productId: string;
  productName: string;
  variantId: string | null;
  existing: { id: string; body: string } | null;
  isLoading: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const headingId = `${id}-heading`;
  const introId = `${id}-intro`;
  const counterId = `${id}-counter`;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [draft, setDraft] = useState(existing?.body ?? '');
  const [error, setError] = useState<string | null>(null);

  // The stored text can arrive after the panel opened; take it while the
  // shopper has not started typing over the empty box.
  const seeded = useRef(existing !== null);
  useEffect(() => {
    if (seeded.current || existing === null) return;
    seeded.current = true;
    setDraft(existing.body);
  }, [existing]);

  // Focus the box once it is there. Inline, not modal, so nothing else moves
  // focus in for us; the heading is the box's description, so a screen reader
  // hears what it is for as it lands.
  useEffect(() => {
    if (!isLoading) textareaRef.current?.focus();
  }, [isLoading]);

  const save = useMutation({
    mutationFn: (body: string) => saveOwnInstruction({ productId, variantId, body }),
    onSuccess: (result) => {
      // Written straight into the cache rather than invalidated. The answer is
      // in hand, the server is authoritative about it, and a refetch would put
      // the button through "Edit -> Add -> Edit" while it flies.
      client.setQueryData(instructionQueryKey(productId, variantId), result);

      toast.success(
        result === null ? t('instructions.removed') : t('instructions.sentToTheSeller'),
      );
      onClose();
    },
    onError: (failure: unknown) => {
      // The panel deliberately stays open and the words stay in the box. A
      // paragraph somebody typed must not disappear because a request timed
      // out — the same rule the basket's note follows.
      setError(errorMessage(t, failure, t('instructions.couldNotBeSent')));
    },
  });

  const isBusy = save.isPending;
  // Leading and trailing blank space is not an instruction. What is inside is
  // the shopper's, line breaks included; React renders it as text, never HTML.
  const cleaned = draft.trim();
  const unchanged = cleaned === (existing?.body ?? '');

  // Escape closes it, from anywhere inside. A listener on the panel rather
  // than a handler on the element: the panel is a dialog region, not a control.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (!isBusy) onClose();
    };
    panel.addEventListener('keydown', onKey);
    return () => {
      panel.removeEventListener('keydown', onKey);
    };
  }, [isBusy, onClose]);

  const submit = (body: string): void => {
    // `isPending` as well as the disabled button: a second Enter or a double
    // tap that lands before the re-render must not send the same words twice.
    if (save.isPending) return;
    setError(null);
    save.mutate(body);
  };

  return (
    <div
      id={id}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      aria-describedby={introId}
      className="mt-2 w-full max-w-lg rounded-lg border border-border bg-surface p-4 shadow-card"
      ref={panelRef}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="text-sm font-semibold text-ink">
            {t('instructions.dialogTitle')}
          </h3>
          <p id={introId} className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            {t('instructions.dialogIntro', { product: productName })}
          </p>
        </div>
        <button
          type="button"
          aria-label={t('instructions.close')}
          title={t('instructions.close')}
          disabled={isBusy}
          onClick={onClose}
          className="-mr-1 -mt-1 inline-flex size-9 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-50"
        >
          <CloseIcon />
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-ink-muted">
          <Spinner className="h-4 w-4" />
          {t('common.loading')}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <label htmlFor={`${id}-text`} className="sr-only">
            {t('instructions.fieldLabel')}
          </label>
          <Textarea
            ref={textareaRef}
            id={`${id}-text`}
            aria-describedby={counterId}
            value={draft}
            rows={4}
            // The browser enforces the limit while typing and pasting, so the
            // box can never hold more than the server will take.
            maxLength={MAX_INSTRUCTION_CHARS}
            disabled={isBusy}
            invalid={error !== null}
            placeholder={t('instructions.placeholder')}
            onChange={(event) => {
              setDraft(event.currentTarget.value.slice(0, MAX_INSTRUCTION_CHARS));
              if (error !== null) setError(null);
            }}
          />

          <div className="flex items-start justify-between gap-3">
            {error === null ? (
              <span />
            ) : (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
            {/* Counts up against the limit: "125/500". Read with the box, not
                announced on every keystroke. */}
            <p
              id={counterId}
              className={cx(
                'shrink-0 text-right text-xxs tabular',
                MAX_INSTRUCTION_CHARS - draft.length <= 25 ? 'text-warning' : 'text-ink-subtle',
              )}
            >
              {t('instructions.counter', {
                used: formatNumber(draft.length),
                max: formatNumber(MAX_INSTRUCTION_CHARS),
              })}
            </p>
          </div>

          <p className="rounded-md bg-surface-sunken px-3 py-2 text-xxs leading-relaxed text-ink-muted">
            {t('instructions.privacyNote')}
          </p>

          {/* `flex-wrap`: at 320px these do not fit on one line, and a Save
              button half off the edge of a phone is a panel nobody can finish. */}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {existing !== null && (
              <Button
                variant="ghost"
                size="sm"
                disabled={isBusy}
                className="mr-auto text-danger hover:bg-danger-soft"
                onClick={() => {
                  // Clearing the box IS the delete, server-side. One code path
                  // for "take back what I said" rather than two that can
                  // disagree about what an empty string means.
                  submit('');
                }}
              >
                {t('instructions.remove')}
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={isBusy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              isLoading={isBusy}
              disabled={unchanged || (existing === null && cleaned === '')}
              onClick={() => {
                submit(cleaned);
              }}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A pencil over a line. `aria-hidden`: the button already says the words. */
function PencilIcon(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
