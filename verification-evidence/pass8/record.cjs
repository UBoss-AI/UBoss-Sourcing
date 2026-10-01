// Pass 8 (Sections 12, 14, 17): record verified boxes in state.json and
// Checklist.md, then tick them in the Word file through tick-box.cjs.
//   node verification-evidence/pass8/record.cjs verification-evidence/pass8/batch-N.json
// The batch file is [{ "id": "SEC-002", "evidence": "..." }, ...].
// Only ids whose evidence is given are touched; the Word change is verified
// box by box by tick-box.cjs before it replaces the file.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '../..');
const batch = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const mapping = new Map(require('../checklist-mapping.json').map((m) => [m.id, m]));
const today = new Date().toISOString().slice(0, 10);

for (const { id, evidence } of batch) {
  if (!mapping.has(id)) throw new Error(`unknown id ${id}`);
  if (typeof evidence !== 'string' || evidence.length < 40) throw new Error(`${id}: evidence too short`);
}

const tick = JSON.parse(
  execFileSync('node', [path.join(root, 'verification-evidence/pass4/tick-box.cjs'), ...batch.map((b) => b.id)], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .pop(),
);

const statePath = path.join(root, 'verification-evidence/pass4/state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
for (const { id, evidence } of batch) {
  state.otherBoxes = state.otherBoxes.filter((row) => row.id !== id);
  state.otherBoxes.push({ id, status: 'VERIFIED', evidence, verifiedAt: `${today} (pass 8)` });
}
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

const mdPath = path.join(root, 'Checklist.md');
let lines = fs.readFileSync(mdPath, 'utf8').split('\n');
const eol = lines[0].endsWith('\r') ? '\r' : '';
const cell = (text) => text.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const humanStart = lines.findIndex((l) => l.startsWith('### Boxes that need a person'));
const otherStart = lines.findIndex((l) => l.startsWith('## Other checklist boxes verified'));
for (const { id, evidence } of batch) {
  const req = cell(mapping.get(id).requirement);
  const row = `| ${id} | ${req} | **VERIFIED** | ${cell(evidence)} | ☑ | ${today} (pass 8) |${eol}`;
  // A box software has now verified is no longer waiting for a person.
  lines = lines.filter((l, i) => !(i > humanStart && i < otherStart && l.startsWith(`| ${id} |`)));
  const start = lines.findIndex((l) => l.startsWith('## Other checklist boxes verified'));
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end += 1;
  const existing = lines.findIndex((l, i) => i > start && i < end && l.startsWith(`| ${id} |`));
  if (existing >= 0) lines[existing] = row;
  else {
    let last = start;
    for (let i = start; i < end; i += 1) if (lines[i].startsWith('| ')) last = i;
    lines.splice(last + 1, 0, row);
  }
}
let md = lines.join('\n');
md = md.replace(/^- Entire document checked:.*$/m, `- Entire document checked: ${tick.total.checked}`);
md = md.replace(/^- Entire document unchecked:.*$/m, `- Entire document unchecked: ${tick.total.unchecked}`);
fs.writeFileSync(mdPath, md, 'utf8');
console.log(JSON.stringify({ recorded: batch.map((b) => b.id), ...tick }));
