/**
 * The last line of defence.
 *
 * A render error anywhere below this unmounts the tree and React shows a blank
 * page. A blank page in an admin panel reads as "the server is down" and
 * produces a support call about the wrong thing, so this catches it and says
 * what actually happened.
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
            Nothing you were doing has been saved. Reloading usually clears it.
          </p>
          <p className="mt-3 break-words font-mono text-xxs text-ink-subtle">{error.message}</p>
          <button
            type="button"
            onClick={() => { window.location.reload(); }}
            className="mt-5 inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}
