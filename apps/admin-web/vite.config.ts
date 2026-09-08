import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * `npm run dev:tunnel` serves this dev server through an HTTPS tunnel (ngrok)
 * so someone outside this machine can look at it. Under plain `npm run dev`
 * every branch below is inert and the server behaves exactly as it always has,
 * with one deliberate exception: `allowedHosts` names the tunnel host in every
 * mode, so opening the tunnel URL is never refused outright. See the note on it
 * below.
 *
 * The signal is Vite's own `--mode tunnel` rather than an environment
 * variable, because `TUNNEL=1 npm run dev` is not something PowerShell can
 * say and this project is developed on Windows - a script that only works on
 * one shell is a script that gets rediscovered as a bug. `TUNNEL=1` is still
 * honoured for anyone on a POSIX shell already used to it.
 */
export default defineConfig(({ mode }) => {
  const throughTunnel = mode === 'tunnel' || process.env.TUNNEL === '1';

  // Which Host headers this server answers to besides loopback - in EVERY mode.
  //
  // Vite's host check is a DNS-rebinding defence: by default only `localhost`
  // and the configured `host` get an answer, and any other Host header is
  // refused with "Blocked request. This host is not allowed." Opening the
  // tunnel URL against an ordinary `npm run dev` server therefore hits a wall
  // whose only advice is to edit this file - which is exactly how that wall
  // keeps coming back, once per person who forgot `dev:tunnel` exists.
  //
  // Naming the reserved tunnel host settles it: the page loads in either mode.
  // Hot reload still wants `dev:tunnel`, because only that knows to dial 443,
  // so this is the difference between a working page and a flat refusal - not
  // a replacement for the tunnel script.
  //
  // A bare hostname, no scheme and no path, read from TUNNEL_HOST in
  // `.env.local`. Unset on a machine that never tunnels, which leaves the
  // check exactly at its default.
  const tunnelHost = loadEnv(mode, process.cwd(), '').TUNNEL_HOST?.trim();

  return {
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

      // IPv4 loopback, explicitly, and not only under a tunnel.
      //
      // Vite's default host is the NAME "localhost", which on Windows resolves
      // to ::1 first - so the server ends up listening on IPv6 only.
      // `http://localhost:5173` then works in a browser (it retries the other
      // family) and `http://127.0.0.1:5173` does not, which is the worse half
      // of the deal: a numeric address is what SETUP.md, ngrok and anything
      // scripted reaches for, and what comes back is a blank error page rather
      // than a connection refused anybody can read.
      //
      // Loopback either way, so this exposes nothing to the network that the
      // default did not. `npm run dev -- --host` still overrides it for
      // somebody who wants the LAN.
      host: '127.0.0.1',

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

      // Decided above. `true` under a tunnel because the agent can be run
      // without a reserved domain, and a hostname issued at connect time
      // cannot be named in advance; that only lifts the DNS-rebinding guard on
      // a dev server which is already deliberately public. Outside a tunnel it
      // is the one named host, or Vite's default when TUNNEL_HOST is unset.
      allowedHosts: throughTunnel ? true : tunnelHost ? [tunnelHost] : [],

      ...(throughTunnel
        ? {
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
  };
});
