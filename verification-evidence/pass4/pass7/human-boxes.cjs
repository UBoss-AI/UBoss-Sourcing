// Writes the "needs a person" section of Checklist.md: every unticked box that
// software cannot verify, with why and who verifies it.
const fs=require('fs');const path=require('path');const AdmZip=require(path.resolve('scripts/node_modules/adm-zip'));
const m=Object.values(require(path.resolve('verification-evidence/checklist-mapping.json')));
const xml=new AdmZip('UBoss_Gloviaa_Mart_Detailed_Screen_Checklist_V2.docx').readAsText('word/document.xml');
const b=[];for(const x of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g))for(const c of x[1])if(c==='☐'||c==='☑')b.push(c);
const who={TEMPLATE:'QA lead fills in Pass / Fail / N/A per test run',SIGNOFF:'Named approvers choose Approve or Hold',LIVE:'Product owner, QA, security, legal and operations sign this off before launch'};
const human=new Set(['DOD-043','DOD-044','SEC-008','SEC-010']);
const rows=m.filter(r=>b[r.ord-1]==='☐'&&(who[r.id.replace(/-\d+$/,'')]||human.has(r.id)));
const reasonFor=r=>who[r.id.replace(/-\d+$/,'')]??({'DOD-043':'Real browsers and devices (Safari, Android, iOS) must be tried by a person','DOD-044':'Performance must be measured on the production host with real data','SEC-008':'Fraud controls need a risk owner to define thresholds and review cases','SEC-010':'Backup, restore and disaster recovery must be rehearsed on the real servers'})[r.id];
const nl='\r\n';const lines=['### Boxes that need a person (not ticked by software)','','These boxes are sign-offs, blank forms or checks on real devices, servers or people. Software cannot tick them honestly. Each one stays unticked until the person named verifies it and ticks it in the Word file.','','| Box | Requirement | Who verifies it |','| --- | --- | --- |',...rows.map(r=>`| ${r.id} | ${r.requirement.replace(/\|/g,'/').slice(0,110)} | ${reasonFor(r)} |`),'',''];
let s=fs.readFileSync('Checklist.md','utf8');const start='### Boxes that need a person';
if(s.includes(start)){const i=s.indexOf(start);const j=s.indexOf('<!-- PASS4:START -->');s=s.slice(0,i)+s.slice(j);}
s=s.replace('<!-- PASS4:START -->',()=>lines.join(nl)+'<!-- PASS4:START -->');fs.writeFileSync('Checklist.md',s);console.log('human boxes',rows.length);
