/// <reference types="vitest/config" />
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
 *
 * Nothing reads `import.meta.env.MODE`, and `.env.local` loads in every mode,
 * so the mode name costs nothing beyond being the flag.
 */
export default defineConfig(({ mode }) => {
  const throughTunnel = mode === 'tunnel' || process.env.TUNNEL === '1';

  // `npm run build:netlify`. A static host serves this bundle to the public
  // internet, so the source maps stay behind: `sourcemap: true` publishes every
  // .ts and .tsx file in this app next to the bundle, readable by anyone who
  // opens devtools. That is fine on a dev server and not fine on a URL handed
  // to a customer. Nothing else about the build changes - the API base comes
  // from `.env.netlify`, which this mode loads.
  const forNetlify = mode === 'netlify';

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
  // Hot reload and the /admin proxy still want `dev:tunnel`, so this is the
  // difference between a working page and a flat refusal - not a replacement
  // for the tunnel script.
  //
  // A bare hostname, no scheme and no path, read from TUNNEL_HOST in
  // `.env.local`. Unset on a machine that never tunnels, which leaves the
  // check exactly at its default.
  const tunnelHost = loadEnv(mode, process.cwd(), '').TUNNEL_HOST?.trim();

  return {
    plugins: [react()],
    /*
     * MapLibre is served from its own package, never pre-bundled.
     *
     * Vite's dependency optimiser rewrites `maplibre-gl` into
     * `node_modules/.vite/deps/` and does not copy its sibling
     * `maplibre-gl-worker.mjs` with it. The library then creates its worker
     * from a URL beside itself, that URL 404s, and **nothing reports it**: the
     * map is built, the style loads, tiles are requested and downloaded, and
     * every one of them is then handed to a worker that does not exist. What
     * the reader sees is a map with no roads, no water and no labels, stuck
     * under its own loading message, with an empty console.
     *
     * Excluding it means the browser loads `maplibre-gl.mjs` from the package
     * itself, where the worker sits next to it. Development only - a
     * production build bundles the worker correctly either way - but that is
     * exactly the split that made this expensive to find.
     */
    optimizeDeps: { exclude: ['maplibre-gl'] },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      // The backend's CORS allowlist names this exact origin, from
      // CUSTOMER_WEB_ORIGIN in the API's .env. strictPort makes a clash fail
      // loudly rather than silently moving to a port CORS will reject.
      port: 5174,
      strictPort: true,

      // IPv4 loopback, explicitly, and not only under a tunnel.
      //
      // Vite's default host is the NAME "localhost", and on Windows that
      // resolves to ::1 first, leaving the server on IPv6 only. The ngrok
      // agent dials 127.0.0.1, finds nothing, and reports the upstream as
      // refused - which reads as "the dev server is down" when it is up and
      // answering on the other address family. A browser asking for
      // `127.0.0.1:5174` gets the same nothing, with even less explanation.
      //
      // Loopback either way, so nothing is exposed that the default did not.
      // `npm run dev -- --host` still overrides it.
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
          headers: { origin: 'http://localhost:5174' },
        },
        '/media': {
          target: 'http://localhost:4000',
          changeOrigin: false,
        },
        // A free tunnel gives out one hostname, so the admin panel lives behind
        // /admin on it and the logistics portal behind /logistics, rather than
        // each needing a tunnel of its own; both are built with a matching
        // `base` then, so their own asset URLs line up. Only under a tunnel:
        // locally each runs at base=/ on its own port, and proxying them here
        // would serve markup whose asset URLs 404.
        //
        // The logistics portal is the one of the three that has a hostname of
        // its own in production - a carrier never reaches it under the
        // storefront. This is a development arrangement so that all three can
        // be shown from one free tunnel, and nothing outside dev depends on it.
        ...(throughTunnel
          ? {
              '/admin': {
                target: 'http://localhost:5173',
                changeOrigin: false,
              },
              '/logistics': {
                target: 'http://localhost:5175',
                changeOrigin: false,
              },
            }
          : {}),
      },

      // Decided above. `true` under a tunnel because the agent can be run
      // without a reserved domain, and a hostname issued at connect time
      // cannot be named in advance; that only lifts the DNS-rebinding guard on
      // a dev server which is already deliberately public. Outside a tunnel it
      // is the one named host, or Vite's default when TUNNEL_HOST is unset.
      allowedHosts: throughTunnel ? true : tunnelHost ? [tunnelHost] : [],

      ...(throughTunnel
        ? {
            // HMR would otherwise dial ws://<tunnel-host>:5174, which is not
            // reachable. The tunnel terminates TLS on 443.
            hmr: { clientPort: 443, protocol: 'wss' as const },
          }
        : {}),
    },
    build: {
      outDir: 'dist',
      sourcemap: !forNetlify,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
    },
  };
});
