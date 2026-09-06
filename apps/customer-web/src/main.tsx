import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { SessionProvider } from '@/auth/SessionProvider';
import { StorefrontProvider } from '@/app/StorefrontProvider';
import { LocaleProvider } from '@/app/LocaleProvider';
import { I18nProvider } from '@/i18n/I18nProvider';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { queryClient } from '@/app/queryClient';
import { router } from '@/app/router';
import { ToastProvider } from '@/components/toast';
import './index.css';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('The #root element is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <StorefrontProvider>
          <ToastProvider>
            <SessionProvider>
              {/* Inside the session so the account's saved language wins over
                  the browser's guess, and outside the router so every screen —
                  the sign-in page included — is already translated on first
                  paint. Language and market are separate providers on purpose:
                  a Polish buyer paying in euro is an ordinary case. */}
              <I18nProvider>
                {/* Inside the session: the shopper's saved market is read from
                    their profile, and adopted from localStorage on sign-in. */}
                <LocaleProvider>
                  <RouterProvider router={router} />
                </LocaleProvider>
              </I18nProvider>
            </SessionProvider>
          </ToastProvider>
        </StorefrontProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
