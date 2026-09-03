/**
 * Toasts.
 *
 * Confirmation of something that already happened - "Product saved", "Import
 * confirmed". Never used to ask a question or report an error a user must act
 * on: a toast disappears, and anything that disappears cannot carry a decision.
 *
 * The container is an `aria-live` region so a screen reader hears the message
 * without focus moving, which would interrupt whatever the user was doing.
 */
import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { ToastContext } from './toast-context';
import type { ToastApi, ToastTone } from './toast-context';

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

const TONE_CLASSES: Record<ToastTone, string> = {
  success: 'border-success/30 bg-success-soft text-success',
  error: 'border-danger/30 bg-danger-soft text-danger',
  info: 'border-border-strong bg-surface text-ink',
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId++;
      setToasts((current) => [...current, { id, tone, message }]);
      // Errors linger: they are usually longer and more consequential to read.
      window.setTimeout(
        () => {
          dismiss(id);
        },
        tone === 'error' ? 8000 : 4000,
      );
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => {
        push('success', message);
      },
      error: (message) => {
        push('error', message);
      },
      info: (message) => {
        push('info', message);
      },
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cx(
              'pointer-events-auto flex items-start gap-3 rounded-md border px-4 py-3 text-sm shadow-popover',
              TONE_CLASSES[toast.tone],
            )}
          >
            <span className="flex-1">{toast.message}</span>
            <button
              type="button"
              onClick={() => {
                dismiss(toast.id);
              }}
              className="shrink-0 rounded text-xs font-medium underline underline-offset-2 opacity-70 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
