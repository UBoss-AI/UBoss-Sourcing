// Ticks (or unticks) exactly one Master Checklist row in the Word file.
//   node verification-evidence/pass4/tick.cjs <masterId> [check|uncheck]
// Only the single ☐/☑ character inside that row's Done cell changes; every
// other byte of document.xml is left as it was. Saved to a temp file, reopened
// and re-counted, then moved over the original.
const fs = require('fs');
const path = require('path');
const AdmZip = require(path.join(__dirname, '../../scripts/node_modules/adm-zip'));

const DOCX = process.env.CHECKLIST_DOCX ?? path.join(__dirname, '../../UBoss_Gloviaa_Mart_Detailed_Screen_Checklist_V2.docx');
const id = Number(process.argv[2]);
const mode = process.argv[3] ?? 'check';
const [from, to] = mode === 'check' ? ['☐', '☑'] : ['☑', '☐'];

const text = (s) => [...s.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
function masterRows(xml) {
  const idx = xml.indexOf('Master Screen Inventory');
  const t0 = xml.indexOf('<w:tbl>', idx);
  const t1 = xml.indexOf('</w:tbl>', t0);
  const out = [];
  const re = /<w:tr[ >][\s\S]*?<\/w:tr>/g;
  re.lastIndex = t0;
  let m;
  while ((m = re.exec(xml)) && m.index < t1) {
    const cells = [...m[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)];
    const first = cells[0] ? text(cells[0][0]).trim() : '';
    if (!/^\d+$/.test(first)) continue;
    out.push({ id: Number(first), start: m.index, xml: m[0], cells });
  }
  return out;
}
function counts(xml) {
  const all = text(xml);
  const rows = masterRows(xml);
  return {
    checked: (all.match(/☑/g) || []).length,
    unchecked: (all.match(/☐/g) || []).length,
    master: rows.map((r) => [r.id, text(r.xml).includes('☑')]),
  };
}

const zip = new AdmZip(DOCX);
const xml = zip.readAsText('word/document.xml');
const row = masterRows(xml).find((r) => r.id === id);
if (!row) throw new Error(`Master row ${id} not found`);
const last = row.cells[row.cells.length - 1];
const cellStart = row.start + last.index;
const cellXml = last[0];
const at = cellXml.indexOf(from);
if (at === -1) {
  console.log(`row ${id} already ${mode === 'check' ? 'checked' : 'unchecked'}; nothing changed`);
  process.exit(0);
}
if (cellXml.indexOf(from, at + 1) !== -1) throw new Error('more than one box in the cell');
const pos = cellStart + at;
const next = xml.slice(0, pos) + to + xml.slice(pos + from.length);

const before = counts(xml);
const after = counts(next);
const changed = after.master.filter(([rid, c], i) => c !== before.master[i][1]).map(([rid]) => rid);
if (changed.length !== 1 || changed[0] !== id) throw new Error(`unexpected change set: ${changed}`);
const delta = mode === 'check' ? 1 : -1;
if (after.checked !== before.checked + delta || after.unchecked !== before.unchecked - delta) throw new Error('count mismatch');

zip.updateFile('word/document.xml', Buffer.from(next, 'utf8'));
const tmp = DOCX.replace(/\.docx$/, '.tmp.docx');
zip.writeZip(tmp);
const reopened = counts(new AdmZip(tmp).readAsText('word/document.xml'));
if (reopened.checked !== after.checked) throw new Error('reopened file does not match');
fs.renameSync(tmp, DOCX);
console.log(JSON.stringify({ row: id, mode, total: { checked: after.checked, unchecked: after.unchecked }, masterChecked: after.master.filter(([, c]) => c).length }));
