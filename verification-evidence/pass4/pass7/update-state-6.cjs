const fs=require('fs');const file='verification-evidence/pass4/state.json';const s=JSON.parse(fs.readFileSync(file,'utf8'));
const r=s.rows.find(x=>x.id===62);const t='MessagesPage tests + i18n 71/71; tsc and lint clean';
Object.assign(r,{status:'FIXED_AND_VERIFIED',pass4Done:true,verifiedAt:'2026-09-30 (pass 7)',finding:'Message centre held order/preorder conversations with attachments, but RFQ supplier conversations (per RFQ, with a files tab) were not reachable from it.',fix:'Message centre header lists the buyer\'s open and awarded RFQs, linking to each RFQ\'s supplier conversations. 8 languages.',tests:t,evidence:t,testResult:t,verification:t});
fs.writeFileSync(file,JSON.stringify(s,null,2)+'\n');
