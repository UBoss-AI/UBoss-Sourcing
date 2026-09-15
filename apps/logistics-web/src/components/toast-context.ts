/**
 * The toast context and its hook.
 *
 * Split from the provider for the same reason the session context is - a file
 * that exports both a component and a hook cannot keep its state across a Fast
 * Refresh edit.
 */
import { createContext, useContext } from 'react';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const context = useContext(ToastContext);

  if (context === null) {
    throw new Error('useToast must be used inside a ToastProvider.');
  }

  return context;
}
