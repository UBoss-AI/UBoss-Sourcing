/**
 * Builds all three front ends into ONE folder, for a single Netlify site that
 * serves the storefront at `/`, the console at `/admin/` and the carrier
 * portal at `/logistics/`.
 *
 * WHY ONE SITE RATHER THAN THREE
 *
 * Three sites is the arrangement the netlify.toml in each application
 * describes, and it is the right one for a real installation: the console is
 * not a public website, and a carrier reaches the portal on a hostname of its
 * own. This script is for the other case - showing the whole system to
 * somebody who is evaluating it, where three addresses is three things for
 * them to keep hold of and a single link is one.
 *
 * Nothing about it is required by the applications. Each still builds and
 * deploys on its own exactly as before; this only arranges three ordinary
 * builds into one directory tree.
 *
 * WHAT MAKES IT WORK
 *
 * `VITE_BASE_PATH`. Vite writes every asset URL with the base prefix baked in,
 * so an application served under `/admin/` has to be BUILT knowing that - a
 * build made for `/` and copied into an `admin` folder loads its HTML and then
 * fetches all of its JavaScript from the storefront's paths. Each router reads
 * the same value back through `import.meta.env.BASE_URL` as its basename, so
 * client-side routes resolve under the prefix too.
 *
 * The API is NOT built in. `.env.netlify` sets a relative `/api/v1`, and the
 * root netlify.toml proxies that to wherever the API actually is, which is
 * what keeps the browser on one origin and the session cookies SameSite=Lax.
 *
 * Run it from the repository root:
 *
 *   node scripts/build-netlify-combined.mjs
 *
 * and publish `output/netlify-site`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'output', 'netlify-site');

/**
 * The three, in the order they are copied.
 *
 * The storefront is first and lands at the root; the other two land in a
 * subdirectory each. Order matters only in that the storefront must not be
 * copied over the others - it is not, because it is copied first.
 */
const apps = [
  { name: 'customer-web', base: '/', into: '.', demoVar: 'VITE_DEMO_LOGINS_CUSTOMER' },
  { name: 'admin-web', base: '/admin/', into: 'admin', demoVar: 'VITE_DEMO_LOGINS_ADMIN' },
  {
    name: 'logistics-web',
    base: '/logistics/',
    into: 'logistics',
    demoVar: 'VITE_DEMO_LOGINS_LOGISTICS',
  },
];

/**
 * The demo sign-ins for one application, or nothing.
 *
 * Three applications now share one site, and therefore one set of environment
 * variables - so the single `VITE_DEMO_LOGINS` each application reads has to
 * be handed to it per application here. The API scopes a session to an
 * audience, so the console's accounts are refused by the storefront: one
 * shared list would put accounts on each login page that cannot sign in
 * there, which reads as a broken site rather than a demonstration.
 *
 * Unset means unset. The panel renders nothing, which is what every
 * non-demonstration build should do.
 */
function demoLoginsFor(app) {
  const value = process.env[app.demoVar];
  return value === undefined || value.trim().length === 0 ? {} : { VITE_DEMO_LOGINS: value };
}

/**
 * Run a command, inheriting stdio so the build's own output is the log.
 *
 * `shell: true` because on Windows `npm` is `npm.cmd` and spawn will not find
 * it otherwise. The arguments here are all written in this file, never taken
 * from input, so there is nothing for a shell to interpret that we did not put
 * there ourselves.
 */
function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true, ...options });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

console.log(`Building three applications into ${outDir}\n`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const app of apps) {
  const cwd = join(repoRoot, 'apps', app.name);
  console.log(`\n--- ${app.name}  (base ${app.base}) ---`);

  // A missing node_modules is the one failure worth pre-empting, because the
  // error vite gives for it names a module rather than the cause.
  if (!existsSync(join(cwd, 'node_modules'))) {
    run('npm', ['ci'], { cwd });
  }

  run('npm', ['run', 'build:netlify'], {
    cwd,
    env: { ...process.env, VITE_BASE_PATH: app.base, ...demoLoginsFor(app) },
  });

  const dist = join(cwd, 'dist');
  if (!existsSync(dist)) {
    throw new Error(`${app.name} produced no dist/`);
  }

  const destination = app.into === '.' ? outDir : join(outDir, app.into);
  cpSync(dist, destination, { recursive: true });
  console.log(`copied ${app.name}/dist -> ${app.into === '.' ? '(root)' : app.into}`);
}

// The redirects and headers, beside the files they describe. Netlify reads a
// netlify.toml from the root of what is published, which for a combined build
// is not any one application's directory - so it is kept separately and copied
// in here rather than being one of the three the applications own.
const config = join(repoRoot, 'deploy', 'netlify-combined.toml');
if (!existsSync(config)) {
  throw new Error(`missing ${config} - the site would deploy with no /api proxy and no SPA fallback`);
}

/**
 * Where the API actually is, at BUILD time.
 *
 * ## Why this is an environment variable and not a line in the file
 *
 * `deploy/netlify-combined.toml` has to name some host, and whatever it names
 * is wrong for everybody except the person who last edited it. That is not a
 * hypothetical: the four `netlify.toml` files in this repository named a
 * `trycloudflare.com` quick tunnel, the last folder built from them named an
 * ngrok one, the two had silently disagreed for weeks, and by the time anybody
 * looked BOTH were dead - so every `/api/*` call from the deployed site came
 * back 502 and signing in failed with no clue as to why.
 *
 * A quick tunnel is the worst case of this because it takes a NEW random
 * hostname on every restart, so a hostname committed to git is wrong within a
 * day. But the same applies to a real API host that moves once a year: an
 * address belongs to a deployment, not to source control.
 *
 * So: set `API_ORIGIN` in the Netlify UI (Site configuration → Environment
 * variables) and every build from then on points at it. Moving the API is one
 * variable and a redeploy, with nothing to edit, nothing to re-pack and no
 * second copy to drift.
 *
 * Netlify cannot interpolate an environment variable inside `netlify.toml`
 * itself - the file is read as-is - which is exactly why this substitution
 * happens HERE, in the build that writes the file.
 *
 * Unset, the committed placeholder is kept. That is deliberate rather than a
 * failure: a local `node scripts/build-netlify-combined.mjs` should produce a
 * site to look at without anybody exporting anything, and a build with no API
 * behind it renders perfectly well right up to the point somebody signs in.
 */
const apiOrigin = (process.env.API_ORIGIN ?? '').trim().replace(/\/+$/, '');

let toml = readFileSync(config, 'utf8');

if (apiOrigin.length > 0) {
  if (!/^https?:\/\/[^/\s]+$/.test(apiOrigin)) {
    throw new Error(
      `API_ORIGIN must be a scheme and host with no path or trailing slash, e.g. https://api.example.com - got "${apiOrigin}"`,
    );
  }

  // Every `to =` that points at an absolute origin, whatever that origin
  // currently is. Matching the placeholder by name would break the moment
  // somebody edited it, which is the failure this whole block exists to stop.
  const before = toml;
  toml = toml.replace(
    /(to\s*=\s*")https?:\/\/[^/"]+(\/(?:api|media)\/:splat")/g,
    `$1${apiOrigin}$2`,
  );

  if (toml === before) {
    throw new Error(
      `API_ORIGIN was set but no proxy line in ${config} matched - the site would deploy pointing somewhere else`,
    );
  }

  console.log(`API proxy -> ${apiOrigin}`);
} else {
  const placeholder =
    /to\s*=\s*"(https?:\/\/[^/"]+)\/api\/:splat"/.exec(toml)?.[1] ?? '(none)';
  console.warn(
    `
WARNING: API_ORIGIN is not set, so the API proxy keeps the committed placeholder:
` +
      `  ${placeholder}
` +
      `If that host is not live, the site deploys and nobody can sign in - every
` +
      `/api call returns 502. Set API_ORIGIN in the Netlify UI, or export it here.
`,
  );
}

writeFileSync(join(outDir, 'netlify.toml'), toml);

console.log(`\nDone. Publish: ${outDir}`);
console.log('  /            storefront');
console.log('  /admin/      admin console');
console.log('  /logistics/  logistics portal');
