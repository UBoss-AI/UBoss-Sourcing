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

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
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
          <h1 className="text-lg font-semibold text-ink">This page stopped working</h1>
          <p className="mt-2 text-sm text-ink-muted">
            Nothing in your cart has been lost. Reloading usually clears it.
          </p>
          <p className="mt-3 break-words font-mono text-xxs text-ink-subtle">{error.message}</p>
          <div className="mt-5 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => {
                window.location.reload();
              }}
              className="inline-flex h-10 items-center rounded-md bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover"
            >
              Reload the page
            </button>
            <a
              href="/"
              className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-sunken"
            >
              Go to the home page
            </a>
          </div>
        </div>
      </div>
    );
  }
}
