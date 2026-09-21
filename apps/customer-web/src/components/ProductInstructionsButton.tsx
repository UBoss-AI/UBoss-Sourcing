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
 * ## Why it is a real button and not part of the card's link
 *
 * `ProductCard` is a stretched link: an `::after` overlay on the product name
 * makes the whole card follow one anchor, which is the pattern that keeps a
 * grid navigable without turning each card into one unreadable blob for a
 * screen reader. Anything on the card that is NOT that link has to be lifted
 * above the overlay or it is unreachable — the SKU is raised for exactly this
 * reason, and this button is raised the same way.
 *
 * So it is `relative z-[1]`, and it stops the click from bubbling. Without the
 * second half, pressing it would open this dialog AND navigate to the product
 * page behind it.
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
  /** `sm` on a card, `md` on the product page. */
  size?: 'sm' | 'md';
  /**
   * Lift above a stretched link's overlay.
   *
   * True on a card, where the whole tile follows one anchor. False on the
   * product page, where there is no overlay to get above and the extra
   * stacking context is needless.
   */
  isOverStretchedLink?: boolean;
  fullWidth?: boolean;
  className?: string;
}

export function ProductInstructionsButton({
  productId,
  productName,
  variantId = null,
  size = 'sm',
  isOverStretchedLink = false,
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
   * A guest has no instruction by definition, and asking would be a 401 per
   * card in the grid. The button still renders — the point is that the offer
   * is visible before the account is, or nobody finds out the feature exists.
   */
  const existing = useQuery({
    queryKey: instructionQueryKey(productId, variantId),
    queryFn: () => fetchOwnInstruction(productId, variantId),
    enabled: isCustomer,
    // These change only when this shopper changes them, from a dialog that
    // writes the result straight back into this cache. Re-asking on every
    // window focus would be a request per card in the grid for an answer that
    // cannot have moved.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const stored = existing.data ?? null;
  const hasInstruction = stored !== null;

  return (
    <>
      <Button
        size={size}
        variant="ghost"
        fullWidth={fullWidth}
        className={cx(
          // Above the card's stretched-link overlay, or the press navigates
          // instead of opening this. See the header.
          isOverStretchedLink && 'relative z-[1]',
          className,
        )}
        onClick={(event) => {
          // Both halves matter on a card: `preventDefault` for the anchor the
          // overlay belongs to, `stopPropagation` so the press does not reach
          // the card behind this button.
          event.preventDefault();
          event.stopPropagation();

          if (!isCustomer) {
            /*
             * Sign in, then come back to exactly this page.
             *
             * `next` is the path this shopper is standing on, not the product
             * page — they pressed this from a grid and expect to return to the
             * grid, with their place in it.
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
