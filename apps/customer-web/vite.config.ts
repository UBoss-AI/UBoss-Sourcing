/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Set TUNNEL=1 to serve this dev server through an HTTPS tunnel (ngrok) so
 * someone outside this machine can look at it. Unset, every branch below is
 * inert and the server behaves exactly as it always has.
 */
const throughTunnel = process.env.TUNNEL === '1';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // The backend's CORS allowlist names this exact origin, from
    // CUSTOMER_WEB_ORIGIN in the API's .env. strictPort makes a clash fail
    // loudly rather than silently moving to a port CORS will reject.
    port: 5174,
    strictPort: true,

    // Same-origin proxy to the API. A tunnel gives out one hostname, and the
    // visitor's browser resolves `localhost` to their own machine - so an
    // absolute VITE_API_BASE_URL pointing at localhost:4000 loads the page and
    // then fetches nothing. Routing /api and /media through this server keeps
    // the API on the visitor's own origin, which also sidesteps CORS and lets
    // the session and CSRF cookies stay SameSite=Lax.
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: false,
        // The API allowlists exact origins. Through a tunnel the browser sends
        // the tunnel's origin, which is not on that list; presenting the origin
        // the API expects means it behaves identically either way.
        headers: { origin: 'http://localhost:5174' },
      },
      '/media': {
        target: 'http://localhost:4000',
        changeOrigin: false,
      },
      // A free tunnel gives out one hostname, so the admin panel lives behind
      // /admin on it rather than needing a second tunnel of its own; it is
      // built with base=/admin/ then, so its own asset URLs match. Only under
      // a tunnel: locally the panel runs at base=/ on its own port, and
      // proxying it here would serve markup whose asset URLs 404.
      ...(throughTunnel
        ? {
            '/admin': {
              target: 'http://localhost:5173',
              changeOrigin: false,
            },
          }
        : {}),
    },

    ...(throughTunnel
      ? {
          // The tunnel hostname is issued at connect time and is not known
          // here, so the host check cannot name it. This only turns off
          // Vite's DNS-rebinding guard on a dev server that is already
          // deliberately public.
          allowedHosts: true as const,
          // HMR would otherwise dial ws://<tunnel-host>:5174, which is not
          // reachable. The tunnel terminates TLS on 443.
          hmr: { clientPort: 443, protocol: 'wss' as const },
        }
      : {}),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
