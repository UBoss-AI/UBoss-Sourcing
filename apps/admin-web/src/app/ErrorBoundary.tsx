/**
 * The last line of defence.
 *
 * A render error anywhere below this unmounts the tree and React shows a blank
 * page, which in the panel reads as "the system is down" to somebody in the
 * middle of their work. This catches it and shows the same full-page error
 * every route shows, filling the screen because the frame it would sit in is
 * gone.
 *
 * Route errors normally stop at the router's `errorElement` long before they
 * reach here. What gets this far is a crash in a provider or in the router
 * itself, so the page cannot use a router link or a React context: its links
 * are plain `href`s, and it translates through the i18next instance directly.
 *
 * **The error's own message is never shown.** It used to be, in small print.
 * A message written for a developer can name a file, a table or an address,
 * and this page cannot tell which, so the visitor gets the kind's wording and
 * the console gets the details.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { ErrorPage } from '@/components/error-page/ErrorPage';
import { errorActions } from '@/components/error-page/error-actions';
import { classifyError } from '@/components/error-page/error-kind';
import { i18n } from '@/i18n/config';
import type { Translate } from '@/i18n/i18n-context';

interface Props {
  children: ReactNode;
}

interface State {
  error: unknown;
  hasError: boolean;
}

/** The module singleton, so it works with no provider above it. */
const translate = i18n.t.bind(i18n) as unknown as Translate;

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, hasError: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept as a console error on purpose: there is no error-reporting service
    // configured, and swallowing it would leave nothing to debug from.
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    const { kind, statusCode, reference } = classifyError(this.state.error);

    return (
      <ErrorPage
        kind={kind}
        t={translate}
        statusCode={statusCode}
        reference={reference}
        fullScreen
        actions={errorActions(kind, {
          t: translate,
          home: { href: import.meta.env.BASE_URL },
          // Reload rather than re-render: the tree that threw is not in a
          // state worth resuming from.
          retry: () => {
            window.location.reload();
          },
        })}
      />
    );
  }
}
