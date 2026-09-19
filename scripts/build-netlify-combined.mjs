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
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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
cpSync(config, join(outDir, 'netlify.toml'));

console.log(`\nDone. Publish: ${outDir}`);
console.log('  /            storefront');
console.log('  /admin/      admin console');
console.log('  /logistics/  logistics portal');
