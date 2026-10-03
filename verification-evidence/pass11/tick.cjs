// Ticks one verified item end to end: Word box, state.json row, batch json,
// Checklist.md counts/row/batch line, then the audit.
// usage: node tick.cjs <ID> <batch> <evidence-file.txt> <shortRow> <lastWork>
const fs = require('fs'); const { execFileSync } = require('child_process');
const [id, batch, evFile, shortRow, lastWork] = process.argv.slice(2);
const ROOT = 'C:/Users/HP/Desktop/UBoss-Software';
const ev = fs.readFileSync(evFile, 'utf8').trim();
const NL = String.fromCharCode(10);
let md = fs.readFileSync(ROOT + '/Checklist.md', 'utf8');
const crlf = md.includes(String.fromCharCode(13) + NL); md = md.split(String.fromCharCode(13) + NL).join(NL);
const num = (label) => Number(md.match(new RegExp(label + ': (' + '[0-9]+)'))[1]);
const before = { checked: num('Entire document checked'), unchecked: num('Entire document unchecked') };
console.log(execFileSync('node', [ROOT + '/verification-evidence/pass4/tick-box.cjs', id], { encoding: 'utf8' }).trim());
const after = { checked: before.checked + 1, unchecked: before.unchecked - 1 };
const stateF = ROOT + '/verification-evidence/pass4/state.json';
const state = JSON.parse(fs.readFileSync(stateF, 'utf8'));
(id.startsWith('SCREEN-') ? state.rows : state.otherBoxes).push({ id, status: 'VERIFIED', evidence: `Pass 11 batch ${batch}: ${id}. ${ev}`, verifiedAt: '2026-10-04 (pass 11)' });
fs.writeFileSync(stateF, JSON.stringify(state, null, 2) + NL);
fs.writeFileSync(`${ROOT}/verification-evidence/pass10/batch-${batch}.json`, JSON.stringify({ batch: Number(batch), ids: [id], before, after, evidence: ev }, null, 2) + NL);
const rep = (a, b) => { if (!md.includes(a)) throw new Error('miss ' + a); md = md.replace(a, () => b); };
rep(`Entire document checked: ${before.checked}`, `Entire document checked: ${after.checked}`);
rep(`Entire document unchecked: ${before.unchecked}`, `Entire document unchecked: ${after.unchecked}`);
md = md.replace(/current batch evidence: `verification-evidence\/pass10\/batch-[0-9]+\.json`/, `current batch evidence: \`verification-evidence/pass10/batch-${batch}.json\``);
md = md.replace(/- Last completed work: .*/, () => `- Last completed work: ${lastWork}`);
const lines = md.split(NL); const ri = lines.findIndex((l) => l.startsWith(`| ${id} | `) && l.split(" | ").length === 3);
if (ri < 0) throw new Error("row " + id); const cls = lines[ri].split(" | ")[1];
lines[ri] = `| ${id} | ${cls} | ${shortRow} |`; md = lines.join(NL);
const lastBatch = [...md.matchAll(/^\*\*Batch [0-9]+ .*$/gm)].pop();
const at = lastBatch.index + lastBatch[0].length;
md = md.slice(0, at) + NL + NL + `**Batch ${batch} — implemented, verified and ticked: ${id}.** ${ev}` + md.slice(at);
fs.writeFileSync(ROOT + '/Checklist.md', crlf ? md.split(NL).join(String.fromCharCode(13) + NL) : md);
const { spawnSync } = require('child_process'); const a = spawnSync('node', [ROOT + '/verification-evidence/pass4/audit.cjs'], { encoding: 'utf8' }); try { console.log('problems:', JSON.stringify(JSON.parse(a.stdout).problems)); } catch { console.log(a.stdout.slice(-400), a.stderr.slice(-400)); }
