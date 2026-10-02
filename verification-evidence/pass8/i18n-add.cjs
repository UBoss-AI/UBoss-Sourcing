// node i18n-add.cjs <localesDir> <keys.json> [afterKey]
// keys.json: { "key": { "en": "...", "de": "...", ... } } - all eight required.
const fs = require('fs'); const path = require('path');
const [dir, file, after] = process.argv.slice(2);
const add = JSON.parse(fs.readFileSync(file, 'utf8'));
const LANGS = ['en', 'de', 'el', 'es', 'fr', 'it', 'nl', 'pl'];
for (const lang of LANGS) {
  const f = path.join(dir, `${lang}.json`); const raw = fs.readFileSync(f, 'utf8');
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  const obj = JSON.parse(raw); const out = {}; let placed = false;
  const fresh = Object.fromEntries(Object.entries(add).map(([k, v]) => { if (!v[lang]) throw new Error(`${k} missing ${lang}`); return [k, v[lang]]; }));
  for (const [k, v] of Object.entries(obj)) { if (k in fresh) continue; out[k] = v; if (k === after) { Object.assign(out, fresh); placed = true; } }
  if (!placed) Object.assign(out, fresh);
  fs.writeFileSync(f, JSON.stringify(out, null, 2).replace(/\n/g, nl) + (raw.endsWith('\n') ? nl : ''));
}
console.log(`added ${Object.keys(add).length} keys x ${LANGS.length}`);
