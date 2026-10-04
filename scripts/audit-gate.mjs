// CI's npm audit gate: `npm audit --audit-level=high`, minus a short, named
// list of advisories that have no fixed release yet.
//   node ../../scripts/audit-gate.mjs      (run inside the project folder)
// An allowed advisory stops being allowed by itself the moment its package
// publishes a version newer than `lastAffected` - then the fix is an upgrade.
import { execSync } from 'node:child_process';

const ALLOWED = [
  {
    url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
    pkg: 'braces',
    lastAffected: '3.0.3',
    why: 'No fixed braces release exists. It reaches us only through Tailwind 3 at build time, reading our own config - no untrusted input. Removed by the Tailwind 4 upgrade.',
  },
];
const BLOCKING = new Set(['high', 'critical']);

let raw;
try { raw = execSync('npm audit --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); }
catch (e) { raw = e.stdout; } // npm audit exits non-zero when it finds anything
const vulns = JSON.parse(raw).vulnerabilities ?? {};

for (const a of ALLOWED) {
  const latest = execSync(`npm view ${a.pkg} version`, { encoding: 'utf8' }).trim();
  if (latest !== a.lastAffected) {
    console.error(`::error::${a.pkg} ${latest} is out - ${a.url} is no longer allowed. Upgrade and remove it from scripts/audit-gate.mjs.`);
    process.exit(1);
  }
}

// The advisories behind a package: its own, plus those of what it pulls in.
const advisories = (name, seen = new Set()) => {
  if (seen.has(name) || !vulns[name]) return [];
  seen.add(name);
  return vulns[name].via.flatMap((v) => (typeof v === 'string' ? advisories(v, seen) : [v]));
};
const allowed = new Set(ALLOWED.map((a) => a.url));
const failing = [];
for (const [name, v] of Object.entries(vulns)) {
  const own = advisories(name).filter((a) => BLOCKING.has(a.severity) && !allowed.has(a.url));
  if (own.length) failing.push(`${name}: ${[...new Set(own.map((a) => `${a.severity} ${a.url}`))].join(', ')}`);
}
for (const a of ALLOWED) if (Object.keys(vulns).length) console.log(`allowed ${a.url} (${a.pkg}): ${a.why}`);
if (failing.length) {
  console.error('::error::npm audit found high/critical advisories:\n' + failing.join('\n'));
  process.exit(1);
}
console.log('npm audit gate: no high or critical advisories outside the allowed list.');
