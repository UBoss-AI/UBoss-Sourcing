/**
 * A small label that appears on hover and on keyboard focus.
 *
 * Accessible the way a tooltip has to be to count: the trigger is described
 * by it (`aria-describedby`), it shows on focus as well as hover so a keyboard
 * user gets it too, and Escape hides it without moving focus. It never holds
 * anything the person needs in order to act - the trigger's own label says
 * that - so a touch screen, where there is no hover, loses nothing.
 *
 * The short rise-and-fade is the "animated tooltip" pattern. The global
 * reduced-motion rule in index.css flattens it to an instant change.
 */
import { cloneElement, useId, useState, type ReactElement } from 'react';
import { cx } from '@/lib/cx';

export function Tooltip({
  label,
  children,
  side = 'top',
  align = 'center',
}: {
  label: string;
  /** One focusable element. It receives the describedby and the handlers. */
  children: ReactElement<Record<string, unknown>>;
  side?: 'top' | 'bottom';
  /** Which edge of the trigger the label lines up with. */
  align?: 'center' | 'end';
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
          'pointer-events-none absolute z-30 w-max max-w-60 rounded-md bg-surface-inverse px-2.5 py-1.5',
          'text-xs font-medium text-ink-inverse shadow-popover transition-[opacity,transform] duration-150',
          align === 'center' ? 'left-1/2 -translate-x-1/2' : 'right-0',
          side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
          open ? 'translate-y-0 opacity-100' : cx('opacity-0', side === 'top' ? 'translate-y-1' : '-translate-y-1'),
        )}
      >
        {label}
      </span>
    </span>
  );
}
