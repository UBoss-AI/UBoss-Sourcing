import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { SessionProvider } from '@/auth/session';
import { I18nProvider } from '@/i18n/I18nProvider';
import { ToastProvider } from '@/components/toast';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { queryClient } from '@/app/queryClient';
import { router } from '@/app/router';
import './index.css';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('The #root element is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
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
  </StrictMode>,
);
