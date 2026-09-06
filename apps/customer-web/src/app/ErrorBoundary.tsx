/**
 * The last line of defence.
 *
 * A render error anywhere below this unmounts the tree and React shows a blank
 * page. A blank page on a storefront reads as "the shop is closed" and loses
 * the sale, so this catches it and offers a way back.
 *
 * Reload rather than "try again": the component tree that threw is not in a
 * state worth resuming from.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { i18n } from '@/i18n/config';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  /**
   * Translated through the i18next instance directly, not `useI18n`.
   *
   * This boundary wraps the provider in `main.tsx` - it has to, or a crash
   * inside the provider would have nothing to catch it - so there is no React
   * context to read here, and a class component could not use a hook anyway.
   * The instance is a module singleton, so `i18n.t` works regardless.
   */
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept as a console error on purpose: there is no error-reporting service
    // configured, and swallowing it would leave nothing to debug from.
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;

    if (error === null) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div role="alert" className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-ink">{i18n.t('errorBoundary.heading')}</h1>
          <p className="mt-2 text-sm text-ink-muted">{i18n.t('errorBoundary.body')}</p>
          <p className="mt-3 break-words font-mono text-xxs text-ink-subtle">{error.message}</p>
          <div className="mt-5 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => {
                window.location.reload();
              }}
              className="inline-flex h-10 items-center rounded-md bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover"
            >
              {i18n.t('errorBoundary.reload')}
            </button>
            <a
              href="/"
              className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-hover"
            >
              {i18n.t('errorBoundary.goHome')}
            </a>
          </div>
        </div>
      </div>
    );
  }
}
