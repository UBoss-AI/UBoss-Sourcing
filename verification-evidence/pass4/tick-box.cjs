// Ticks checklist boxes by their id (DOD-002, SEC-001, SCREEN-011, ...), any section.
//   node verification-evidence/pass4/tick-box.cjs DOD-002 SEC-001 ...
// A box is found by its position in document order (checklist-mapping.json `ord`).
// Only the one ☐ character of each box becomes ☑; every other byte of
// document.xml is left as it was. The result is written to a temp file,
// reopened, and every box compared with the original before it replaces it.
const fs = require('fs');
const path = require('path');
const AdmZip = require(path.join(__dirname, '../../scripts/node_modules/adm-zip'));

const DOCX = path.join(__dirname, '../../UBoss_Gloviaa_Mart_Detailed_Screen_Checklist_V2.docx');
const MAPPING = require(path.join(__dirname, '../checklist-mapping.json'));
const ids = process.argv.slice(2);
if (ids.length === 0) throw new Error('usage: tick-box.cjs <id> [id...]');

const byId = new Map(Object.values(MAPPING).map((m) => [m.id, m]));
function boxOffsets(xml) {
  const out = [];
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) {
    const start = m.index + m[0].indexOf('>') + 1;
    for (let i = 0; i < m[1].length; i += 1) {
      if (m[1][i] === '☐' || m[1][i] === '☑') out.push({ at: start + i, ch: m[1][i] });
    }
  }
  return out;
}

const zip = new AdmZip(DOCX);
const xml = zip.readAsText('word/document.xml');
const before = boxOffsets(xml);
if (before.length !== Object.keys(MAPPING).length) throw new Error(`document has ${before.length} boxes, mapping ${Object.keys(MAPPING).length}`);

const targets = new Set();
let next = xml;
for (const id of ids) {
  const m = byId.get(id);
  if (!m) throw new Error(`unknown id ${id}`);
  const box = before[m.ord - 1];
  if (box.ch === '☑') { console.log(`${id}: already ticked`); continue; }
  next = next.slice(0, box.at) + '☑' + next.slice(box.at + 1);
  targets.add(m.ord - 1);
}
if (targets.size === 0) { console.log('nothing to change'); process.exit(0); }

zip.updateFile('word/document.xml', Buffer.from(next, 'utf8'));
const tmp = DOCX.replace(/\.docx$/, '.tmp.docx');
zip.writeZip(tmp);
const reread = boxOffsets(new AdmZip(tmp).readAsText('word/document.xml'));
const changed = reread.map((b, i) => (b.ch !== before[i].ch ? i : -1)).filter((i) => i >= 0);
const expected = [...targets].sort((a, b) => a - b);
if (JSON.stringify(changed) !== JSON.stringify(expected) || reread.some((b, i) => targets.has(i) && b.ch !== '☑')) {
  fs.unlinkSync(tmp);
  throw new Error(`verification failed: changed ${JSON.stringify(changed)} expected ${JSON.stringify(expected)}`);
}
fs.renameSync(tmp, DOCX);
const checked = reread.filter((b) => b.ch === '☑').length;
console.log(JSON.stringify({ ticked: ids.filter((id) => targets.has(byId.get(id).ord - 1)), total: { checked, unchecked: reread.length - checked } }));
