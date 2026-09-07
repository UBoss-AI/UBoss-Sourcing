/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * `npm run dev:tunnel` serves this dev server through an HTTPS tunnel (ngrok)
 * so someone outside this machine can look at it. Under plain `npm run dev`
 * every branch below is inert and the server behaves exactly as it always has.
 *
 * The signal is Vite's own `--mode tunnel` rather than an environment
 * variable, because `TUNNEL=1 npm run dev` is not something PowerShell can
 * say and this project is developed on Windows - a script that only works on
 * one shell is a script that gets rediscovered as a bug. `TUNNEL=1` is still
 * honoured for anyone on a POSIX shell already used to it.
 *
 * Nothing reads `import.meta.env.MODE`, and `.env.local` loads in every mode,
 * so the mode name costs nothing beyond being the flag.
 */
export default defineConfig(({ mode }) => {
  const throughTunnel = mode === 'tunnel' || process.env.TUNNEL === '1';

  return {
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
            // Bind IPv4 loopback explicitly. Vite's default host is the NAME
            // "localhost", and on Windows that resolves to ::1 first, so the
            // server ends up listening on IPv6 only. The ngrok agent dials
            // 127.0.0.1, finds nothing, and reports the upstream as refused -
            // which reads as "the dev server is down" when it is in fact up
            // and answering on the other address family.
            host: '127.0.0.1',
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
  };
});
