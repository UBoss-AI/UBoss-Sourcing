// Applies every queued tick in state.json (rows that passed while the DOCX was
// locked). Each tick is still the single-cell, verified edit in tick.cjs.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const file = path.join(__dirname, 'state.json');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const pending = state.pendingTicks ?? [];
const left = [];
for (const id of pending) {
  try {
    console.log(execFileSync(process.execPath, [path.join(__dirname, 'tick.cjs'), String(id), 'check'], { encoding: 'utf8' }).trim());
  } catch (error) {
    left.push(id);
    console.log(`row ${id}: still locked (${String(error.message).split('\n')[0].slice(0, 80)})`);
  }
}
try { fs.unlinkSync(path.join(__dirname, '../../UBoss_Gloviaa_Mart_Detailed_Screen_Checklist_V2.tmp.docx')); } catch {}
state.pendingTicks = left;
// Boxes outside the Master table, queued the same way.
const boxes = state.pendingBoxes ?? [];
if (boxes.length > 0) {
  try {
    console.log(execFileSync(process.execPath, [path.join(__dirname, 'tick-box.cjs'), ...boxes], { encoding: 'utf8' }).trim());
    state.pendingBoxes = [];
  } catch (error) {
    console.log(`boxes: still locked (${String(error.message).split(String.fromCharCode(10))[0].slice(0, 80)})`);
  }
  try { fs.unlinkSync(path.join(__dirname, '../../UBoss_Gloviaa_Mart_Detailed_Screen_Checklist_V2.tmp.docx')); } catch {}
}
fs.writeFileSync(file, JSON.stringify(state, null, 1));
console.log(JSON.stringify({ pending: left }));
