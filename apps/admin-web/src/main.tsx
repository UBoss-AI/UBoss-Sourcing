import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { SessionProvider } from '@/auth/session';
import { I18nProvider } from '@/i18n/I18nProvider';
import { ToastProvider } from '@/components/toast';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { ThemeProvider } from '@/app/ThemeProvider';
import { queryClient } from '@/app/queryClient';
import { router } from '@/app/router';
import './index.css';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('The #root element is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    {/* Outermost, and outside the session on purpose: a theme belongs to the
        screen rather than to the account, so it has to hold on the sign-in
        page and before any request has been made. The first paint is already
        correct without it — index.html stamps the attribute before React
        exists — and this adopts that decision and owns it from there. */}
    <ThemeProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <SessionProvider>
              {/* Inside the session so the account's saved language wins over
                  the browser's guess, and outside the router so every screen —
                  the sign-in page included — is already translated on first
                  paint. */}
              <I18nProvider>
                <RouterProvider router={router} />
              </I18nProvider>
            </SessionProvider>
          </ToastProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </ThemeProvider>
  </StrictMode>,
);
