/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The logistics partner portal's dev server.
 *
 * Deliberately simpler than the console's: no tunnel mode and no `base`
 * rewriting. Those exist in `apps/admin-web` because the storefront owns the
 * hostname root under a tunnel and proxies `/admin` to it. Nothing proxies
 * this app - a carrier signs into it on its own hostname, which is the whole
 * reason it is a third application rather than a section of one of the other
 * two.
 */
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },

  server: {
    /*
     * 5175, after 5173 (console) and 5174 (storefront).
     *
     * The backend's CORS allowlist names this exact origin. Changing the port
     * without changing LOGISTICS_WEB_ORIGIN in the API's .env breaks every
     * request with a browser error that says nothing about the cause.
     */
    port: 5175,
    strictPort: true,

    /*
     * IPv4 loopback, explicitly.
     *
     * Vite's default host is the NAME "localhost", which on Windows resolves
     * to ::1 first, so the server ends up listening on IPv6 only:
     * `http://localhost:5175` works and `http://127.0.0.1:5175` does not.
     * The numeric address is what SETUP.md and anything scripted reaches for,
     * and what comes back otherwise is a blank error page.
     */
    host: '127.0.0.1',

    // Same-origin proxy to the API, so the session and CSRF cookies stay
    // SameSite=Lax in development exactly as they are in production.
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: false,
        headers: { origin: 'http://localhost:5175' },
      },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
  },

  /*
   * Unit tests, in jsdom.
   *
   * The same shape the storefront uses, minus the dialog shim: nothing here
   * tests a native <dialog> yet, and a setup file that exists only to
   * patch something no test touches is a file that rots.
   */
  test: {
    environment: 'jsdom',
    globals: true,
    css: false,
  },
});
