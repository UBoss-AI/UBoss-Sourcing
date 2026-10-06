/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * The audit console's dev server.
 *
 * In production an auditor signs into this console on its own hostname
 * (`audit.example.com`, beside `carriers.example.com`). That is the reason it
 * is a fourth application rather than a section of the admin console: the
 * people who use it include inspection agencies, who are outside the
 * operator's company, and they get their own sign-in, their own cookies and
 * their own mandatory second factor.
 *
 * Development is the exception, and only because a free tunnel gives out one
 * hostname. `npm run dev:tunnel` serves this app under `/audit` behind the
 * storefront, exactly as the admin console is served under `/admin` and the
 * carrier portal under `/logistics`, so that all four can be shown to somebody
 * who is not at this computer through one tunnel. Under plain `npm run dev`
 * every branch below is inert and the console is at `http://localhost:5176`.
 *
 * The signal is Vite's own `--mode tunnel` rather than an environment
 * variable, because `TUNNEL=1 npm run dev` is not something PowerShell can
 * say and this project is developed on Windows. `TUNNEL=1` is still honoured
 * for anyone on a POSIX shell already used to it.
 */
export default defineConfig(({ mode }) => {
  const throughTunnel = mode === 'tunnel' || process.env.TUNNEL === '1';

  // `npm run build:netlify`. A static host serves this bundle to the public
  // internet, so the source maps stay behind: `sourcemap: true` publishes every
  // .ts and .tsx file in this app next to the bundle, readable by anyone who
  // opens devtools. That is fine on a dev server and not fine on a URL an
  // inspection agency is given. Nothing else about the build changes - the API
  // base comes from `.env.netlify`, which this mode loads.
  const forNetlify = mode === 'netlify';

  // Which Host headers this server answers to besides loopback - in EVERY mode.
  //
  // Vite's host check is a DNS-rebinding defence: any Host header it does not
  // know is refused with "Blocked request. This host is not allowed.", whose
  // only advice is to edit this file. Naming the reserved tunnel host settles
  // it in either mode.
  //
  // A bare hostname, no scheme and no path, read from TUNNEL_HOST in
  // `.env.local`. Unset on a machine that never tunnels, which leaves the
  // check exactly at its default.
  const tunnelHost = loadEnv(mode, process.cwd(), '').TUNNEL_HOST?.trim();

  // The path this build is served under, when something other than "/".
  //
  // A demonstration deployment can put every application on ONE hostname -
  // the storefront at the root, the console under /admin/, the carrier portal
  // under /logistics/, this console under /audit/ - because a free static host
  // gives out one site per deploy. The combined build script sets this for
  // each application in turn and merges the builds into one folder.
  //
  // Unset in every other build, which is why the expression below falls back
  // to the ordinary base. A trailing slash matters: Vite joins this to every
  // asset path as written.
  const basePath = process.env.VITE_BASE_PATH?.trim();

  return {
    // Under a tunnel the storefront owns the hostname root and proxies /audit
    // here, so every asset URL this app emits has to carry that prefix. The
    // router reads the same value back as its basename.
    base: basePath === undefined || basePath.length === 0 ? (throughTunnel ? '/audit/' : '/') : basePath,
    plugins: [react()],

    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },

    server: {
      /*
       * 5176, after 5173 (admin console), 5174 (storefront) and 5175 (carrier
       * portal).
       *
       * The backend's CORS allowlist names this exact origin. Changing the
       * port without changing AUDIT_WEB_ORIGIN in the API's .env breaks every
       * request with a browser error that says nothing about the cause.
       */
      port: 5176,
      strictPort: true,

      /*
       * IPv4 loopback, explicitly.
       *
       * Vite's default host is the NAME "localhost", which on Windows resolves
       * to ::1 first, so the server ends up listening on IPv6 only:
       * `http://localhost:5176` works and `http://127.0.0.1:5176` does not.
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
          // The API allowlists exact origins. Through a tunnel the browser
          // sends the tunnel's origin, which is not on that list; presenting
          // the origin the API expects means it behaves identically either way.
          headers: { origin: 'http://localhost:5176' },
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
            // HMR would otherwise dial ws://<tunnel-host>:5176, which is not
            // reachable. The tunnel terminates TLS on 443.
            hmr: { clientPort: 443, protocol: 'wss' as const },
          }
        : {}),
    },

    // `npm run preview`: the built bundle, on a fixed port of its own so it
    // never lands on whichever of Vite's defaults another app's preview took.
    preview: {
      port: 4176,
      strictPort: true,
      host: '127.0.0.1',
    },

    build: {
      outDir: 'dist',
      sourcemap: !forNetlify,
    },

    /*
     * Unit tests, in jsdom. The setup file is the dialog shim and nothing
     * else: jsdom has no native <dialog> behaviour.
     */
    test: {
      environment: 'jsdom',
      globals: true,
      css: false,
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});
