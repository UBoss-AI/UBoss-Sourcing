/**
 * The two shapes every account screen is built from: a titled panel, and a
 * labelled fact inside it.
 *
 * Extracted because there are eleven screens in this section and each of them
 * is a column of these. Written once, "Edit" is in the same place, at the same
 * weight, with the same accessible name on every one of them — and the
 * alternative is eleven near-identical headers that drift apart the first time
 * one of them is adjusted.
 *
 * Two details in here are the whole reason it is a component rather than a
 * class string.
 *
 * **Edit is a real button with a real accessible name.** "Edit", repeated
 * eight times down a page, is eight controls a screen-reader user cannot tell
 * apart in a list — so the panel's own title is folded into the name: "Edit
 * personal information". The visible word stays "Edit", because a sighted
 * reader has the heading right beside it.
 *
 * **The panel says whether it is open.** `aria-expanded` on the trigger, and
 * the trigger disappears while the form is up — there is a Cancel in the form,
 * and two ways to close one thing is one too many.
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { PencilIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';

export interface AccountPanelProps {
  title: string;
  /** A sentence under the title, where one earns its place. */
  description?: string;
  /**
   * Present only on a panel that can be edited.
   *
   * A panel with no editor renders no control at all rather than a disabled
   * one: purchasing limits are set by the supplier, and an Edit that refuses
   * to do anything is worse than no Edit — it reads as a fault.
   */
  onEdit?: () => void;
  isEditing?: boolean;
  children: ReactNode;
}

export function AccountPanel({
  title,
  description,
  onEdit,
  isEditing = false,
  children,
}: AccountPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-surface p-5 shadow-card sm:p-6"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={headingId} className="text-title-sm text-ink">
            {title}
          </h2>
          {description !== undefined && (
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-muted">
              {description}
            </p>
          )}
        </div>

        {onEdit !== undefined && !isEditing && (
          <button
            type="button"
            onClick={onEdit}
            aria-expanded={isEditing}
            // The name carries the panel, so eight Edits down a page are eight
            // distinguishable controls in a screen reader's list.
            aria-label={t('account.editSection', { section: title })}
            className="-m-1 inline-flex shrink-0 items-center gap-1.5 rounded p-1 text-sm font-medium text-brand transition-colors hover:text-brand-hover hover:underline"
          >
            <PencilIcon aria-hidden="true" className="h-4 w-4" />
            {t('common.edit')}
          </button>
        )}
      </div>

      {children}
    </section>
  );
}

export interface PanelRowProps {
  label: string;
  /**
   * The value, or null.
   *
   * Null renders an em dash rather than an empty cell. A blank space where a
   * value should be is indistinguishable from a value that failed to load;
   * a dash says "nothing here" deliberately.
   */
  value: string | null;
  /** A caption under the value, for a field whose meaning is not obvious. */
  hint?: string;
  /** A status chip beside the value — confirmed, pending, and so on. */
  badge?: ReactNode;
  /** Something small before the value. A flag, in practice. */
  mark?: ReactNode;
}

export function PanelRow({ label, value, hint, badge, mark }: PanelRowProps): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className="mt-1 min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          {mark}
          <span className={cx('min-w-0 break-words text-sm', value === null ? 'text-ink-subtle' : 'text-ink')}>
            {value ?? '—'}
          </span>
          {badge}
        </span>
        {hint !== undefined && (
          <span className="mt-1 block text-xs leading-snug text-ink-muted">{hint}</span>
        )}
      </dd>
    </div>
  );
}
