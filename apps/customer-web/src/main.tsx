import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { SessionProvider } from '@/auth/SessionProvider';
import { StorefrontProvider } from '@/app/StorefrontProvider';
import { LocaleProvider } from '@/app/LocaleProvider';
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
              {/* Inside the session: the shopper's saved market is read from
                  their profile, and adopted from localStorage on sign-in. */}
              <LocaleProvider>
                <RouterProvider router={router} />
              </LocaleProvider>
            </SessionProvider>
          </ToastProvider>
        </StorefrontProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
