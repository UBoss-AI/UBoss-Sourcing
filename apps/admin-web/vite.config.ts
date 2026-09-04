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
  // Under a tunnel the storefront owns the hostname root and proxies /admin
  // here, so every asset URL this app emits has to carry that prefix.
  base: throughTunnel ? '/admin/' : '/',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // The backend's CORS allowlist names this exact origin. Changing the port
    // without changing ADMIN_WEB_ORIGIN in the API's .env breaks every request.
    port: 5173,
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
        headers: { origin: 'http://localhost:5173' },
      },
      '/media': {
        target: 'http://localhost:4000',
        changeOrigin: false,
      },
    },

    ...(throughTunnel
      ? {
          // The tunnel hostname is issued at connect time and is not known
          // here, so the host check cannot name it. This only turns off
          // Vite's DNS-rebinding guard on a dev server that is already
          // deliberately public.
          allowedHosts: true as const,
          // HMR would otherwise dial ws://<tunnel-host>:5173, which is not
          // reachable. The tunnel terminates TLS on 443.
          hmr: { clientPort: 443, protocol: 'wss' as const },
        }
      : {}),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
