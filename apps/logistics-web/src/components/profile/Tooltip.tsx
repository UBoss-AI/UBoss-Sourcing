/**
 * A small label that appears on hover and on keyboard focus.
 *
 * Accessible the way a tooltip has to be to count: the trigger is described
 * by it (`aria-describedby`), it shows on focus as well as hover so a keyboard
 * user gets it too, and Escape dismisses it without moving focus. It never
 * holds anything the person needs in order to act - the trigger's own label
 * says that - so a touch screen, where there is no hover, loses nothing.
 *
 * The rise-and-fade is the "animated tooltip" pattern, kept short. The global
 * reduced-motion rule in index.css flattens it to an instant change.
 */
import { cloneElement, useId, useState, type ReactElement } from 'react';
import { cx } from '@/lib/cx';

export function Tooltip({
  label,
  children,
  side = 'top',
}: {
  label: string;
  /** One focusable element. It receives the describedby and the handlers. */
  children: ReactElement<Record<string, unknown>>;
  side?: 'top' | 'bottom';
}): React.JSX.Element {
  const id = useId();
  const [open, setOpen] = useState(false);

  const show = (): void => {
    setOpen(true);
  };
  const hide = (): void => {
    setOpen(false);
  };

  const trigger = cloneElement(children, {
    'aria-describedby': id,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
    onKeyDown: (event: { key: string }) => {
      if (event.key === 'Escape') hide();
    },
  });

  return (
    <span className="relative inline-flex">
      {trigger}
      <span
        id={id}
        role="tooltip"
        className={cx(
          'pointer-events-none absolute left-1/2 z-30 w-max max-w-56 -translate-x-1/2 rounded-md',
          'bg-surface-inverse px-2 py-1 text-xs font-medium text-ink-inverse shadow-popover',
          'transition-[opacity,transform] duration-150',
          side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
          open
            ? 'translate-y-0 opacity-100'
            : cx('opacity-0', side === 'top' ? 'translate-y-1' : '-translate-y-1'),
        )}
      >
        {label}
      </span>
    </span>
  );
}
