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
 * On the **product page**, in the row with Add to Cart and Set up a repeat
 * purchase. It belongs with those two because it is an alternative to pressing
 * them rather than something you do afterwards: the shopper reading that panel
 * has the specification in front of them, and the thing stopping them is a
 * question they will only ask if asking is offered where the decision is being
 * made. It takes `variant="secondary"` there — the orange and the teal are the
 * two commitments, and a third filled button beside them would read as a third
 * way to buy.
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
 * the first. So the dialog opens in a loading state and fills with their own
 * words, which also turns "Add" into "Edit" on the button itself.
 */
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from './Modal';
import { Button, Field, Spinner, Textarea } from './ui';
import { useToast } from './toast-context';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import {
  MAX_INSTRUCTION_CHARS,
  fetchOwnInstruction,
  instructionQueryKey,
  saveOwnInstruction,
} from '@/lib/product-instructions';

export interface ProductInstructionsButtonProps {
  productId: string;
  /** For the dialog's heading, so it is obvious what is being written about. */
  productName: string;
  /** The version chosen, where one is. Null means the product in general. */
  variantId?: string | null;
  /** `lg` beside the buy buttons, so the row sits on one baseline. */
  size?: 'sm' | 'md' | 'lg';
  /**
   * How loud it is.
   *
   * `secondary` beside Add to Cart, where it is a real third option and has to
   * look like one without competing with the two commitments. `ghost` is the
   * default for anywhere quieter.
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
    // These change only when this shopper changes them, from a dialog that
    // writes the result straight back into this cache. Re-asking on every
    // window focus would be a request for an answer that cannot have moved.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const stored = existing.data ?? null;
  const hasInstruction = stored !== null;

  return (
    <>
      <Button
        size={size}
        variant={variant}
        fullWidth={fullWidth}
        className={className}
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

          setIsOpen(true);
        }}
      >
        <PencilIcon />
        {hasInstruction ? t('instructions.editInstructions') : t('instructions.addInstructions')}
      </Button>

      {isOpen && (
        <InstructionDialog
          productId={productId}
          productName={productName}
          variantId={variantId}
          existing={stored}
          isLoading={existing.isPending}
          onClose={() => {
            setIsOpen(false);
          }}
        />
      )}
    </>
  );
}

/**
 * The box itself.
 *
 * Mounted only while open, so the draft starts from what is stored every time
 * rather than from whatever was typed and abandoned last time. Reopening has
 * to show what is actually saved.
 */
function InstructionDialog({
  productId,
  productName,
  variantId,
  existing,
  isLoading,
  onClose,
}: {
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

  const [draft, setDraft] = useState(existing?.body ?? '');

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
    onError: (error: unknown) => {
      // The dialog deliberately stays open and the words stay in the box. A
      // paragraph somebody typed must not disappear because a request timed
      // out — the same rule the basket's note follows.
      toast.error(errorMessage(t, error, t('instructions.couldNotBeSent')));
    },
  });

  const remaining = MAX_INSTRUCTION_CHARS - draft.length;
  const isBusy = save.isPending;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('instructions.dialogTitle')}
      description={t('instructions.dialogIntro', { product: productName })}
      footer={
        // `flex-wrap` and `w-full`: at 320px these three do not fit on one
        // line, and a Save button half off the edge of a phone is a dialog
        // nobody can complete.
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {existing !== null && (
            <Button
              variant="ghost"
              disabled={isBusy}
              className="mr-auto text-danger hover:bg-danger-soft"
              onClick={() => {
                // Clearing the box IS the delete, server-side. One code path
                // for "take back what I said" rather than two that can
                // disagree about what an empty string means.
                save.mutate('');
              }}
            >
              {t('instructions.remove')}
            </Button>
          )}
          <Button variant="ghost" disabled={isBusy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            isLoading={isBusy}
            disabled={isLoading || draft.trim() === (existing?.body ?? '')}
            onClick={() => {
              save.mutate(draft);
            }}
          >
            {t('instructions.send')}
          </Button>
        </div>
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-ink-muted">
          <Spinner className="h-4 w-4" />
          {t('common.loading')}
        </div>
      ) : (
        <div className="space-y-3">
          <Field
            label={t('instructions.fieldLabel')}
            hint={t('instructions.fieldHint')}
          >
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                value={draft}
                rows={5}
                maxLength={MAX_INSTRUCTION_CHARS}
                disabled={isBusy}
                // No `autoFocus`. The native `<dialog>` this sits in already
                // moves focus into itself on `showModal()`, so adding one here
                // buys nothing and takes the choice of where to start away
                // from anybody using a screen reader, who would be dropped
                // into the box without having heard the heading that says
                // what it is for.
                placeholder={t('instructions.placeholder')}
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                }}
              />
            )}
          </Field>

          {/* Counts DOWN, and turns when it is nearly gone. A count up tells
              somebody how much they have written, which they can see; a count
              down tells them how much room is left, which is the thing they
              cannot. `aria-live="polite"` so it is not read on every
              keystroke. */}
          <p
            aria-live="polite"
            className={cx(
              'text-right text-xxs tabular',
              remaining <= 25 ? 'text-warning' : 'text-ink-subtle',
            )}
          >
            {t('instructions.charactersLeft', { count: remaining })}
          </p>

          <p className="rounded-md bg-surface-sunken px-3 py-2 text-xxs leading-relaxed text-ink-muted">
            {t('instructions.privacyNote')}
          </p>
        </div>
      )}
    </Modal>
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
