// Read-only reconciliation. Never changes a Word checkbox or a verification status.
// Run from the repository root: node verification-evidence/pass4/audit.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const AdmZip = require('../../scripts/node_modules/adm-zip');
const root = path.resolve(__dirname, '../..');
const report = fs.readFileSync(path.join(root, 'Checklist.md'), 'utf8');
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
const mapping = Object.values(JSON.parse(fs.readFileSync(path.join(__dirname, '../checklist-mapping.json'), 'utf8')));
const zip = new AdmZip(path.join(root, 'UBoss_Gloviaa_Mart_Detailed_Screen_Checklist_V2.docx'));
for (const entry of zip.getEntries()) if (!entry.isDirectory) entry.getData();
const xml = zip.readAsText('word/document.xml');
const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(match => match[1]).join('');
const boxes = [...text.matchAll(/[☐☑]/g)].map(match => match[0]);
assert.equal(boxes.length, 364, 'Unexpected total checkbox count');
assert.equal(mapping.length, boxes.length, 'Mapping does not cover the document');
assert.equal(new Set(mapping.map(row => row.ord)).size, boxes.length, 'Duplicate mapping ordinal');
assert.equal(new Set(mapping.map(row => row.id)).size, boxes.length, 'Duplicate mapping ID');
const master = mapping.filter(row => row.id.startsWith('SCREEN-'));
assert.equal(master.length, 97, 'Unexpected Master row count');
const masterStates = new Map(state.rows.map(row => [row.id, row]));
const detailStates = new Map(state.otherBoxes.map(row => [row.id, row]));
const passing = new Set(['VERIFIED', 'FIXED_AND_VERIFIED']);
const problems = [];
const inherited = [];
for (const row of mapping) {
  assert.ok(row.ord >= 1 && row.ord <= boxes.length, `Invalid ordinal for ${row.id}`);
  const isMaster = row.id.startsWith('SCREEN-');
  const current = isMaster ? masterStates.get(Number(row.id.slice(7))) : detailStates.get(row.id);
  const historicLine = report.split(/\r?\n/).find(line => line.startsWith(`| ${row.id} |`));
  const historicalStatus = historicLine?.match(/\*\*([A-Z_]+)\*\*/)?.[1];
  const status = current?.status ?? historicalStatus;
  const checked = boxes[row.ord - 1] === '☑';
  if (checked && !passing.has(status)) problems.push({ id: row.id, status: status ?? 'NO_EVIDENCE', historicalStatus });
  if (checked && current === undefined && passing.has(historicalStatus)) inherited.push(row.id);
  if (!checked && passing.has(current?.status)) problems.push({ id: row.id, status, issue: 'Passing current status but unchecked' });
  if (checked && current !== undefined && passing.has(status) && !current.evidence && !current.verification && !current.testResult) {
    problems.push({ id: row.id, status, issue: 'No evidence recorded' });
  }
}
const checkedMaster = master.filter(row => boxes[row.ord - 1] === '☑').length;
console.log(JSON.stringify({
  docxPackageReadable: true,
  total: { checked: boxes.filter(box => box === '☑').length, unchecked: boxes.filter(box => box === '☐').length },
  master: { total: master.length, checked: checkedMaster, unchecked: master.length - checkedMaster },
  firstUnchecked: master.find(row => boxes[row.ord - 1] === '☐')?.id,
  inheritedDetailedEvidence: inherited,
  problems,
}, null, 2));
if (problems.length > 0) process.exitCode = 1;
