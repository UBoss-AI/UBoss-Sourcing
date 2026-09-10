import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { SessionProvider } from '@/auth/SessionProvider';
import { StorefrontProvider } from '@/app/StorefrontProvider';
import { ThemeProvider } from '@/app/ThemeProvider';
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
    {/* Outermost, and outside the session on purpose: a theme belongs to the
        screen rather than to the account, so it has to hold for a guest, on
        the error page, and before any request has been made. The first paint
        is already correct without it — index.html stamps the attribute before
        React exists — and this adopts that decision and owns it from there. */}
    <ThemeProvider>
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
    </ThemeProvider>
  </StrictMode>,
);
