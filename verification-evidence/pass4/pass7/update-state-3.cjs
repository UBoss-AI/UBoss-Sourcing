const fs=require('fs');const file='verification-evidence/pass4/state.json';const s=JSON.parse(fs.readFileSync(file,'utf8'));
const E={'HOME-005':'AccountMenu uses account-nav groups (orders, RFQs, addresses, security) plus sign out; keyboard-navigable menu',
'HOME-010':'ImageSearchDialog: type/size limits, privacy note, remove picture, camera; similarity disclaimer added pass 7; hero-search tests 87/87',
'HOME-013':'AI Mode grounded in catalogue, AI/vendor disclosure, product links, RFQ handoff added pass 7; AiModePage tests pass',
'HOME-016':'Buyer ERP centre (row 86): keys, mapping, sandbox test, retry, reconciliation, revoke; customer-erp suites',
'HOME-018':'AI Mode notice: AI disclosure, vendor data-use, retention; policy and report-a-wrong-answer links added pass 7',
'UAT-UI-004':'AI Mode question prefills a new RFQ; the buyer edits the form and only submitted values are sent',
'JOURNEY-066':'Admin audit log (row 73): actor, action, object, before/after, IP, export; append-only app DB account',
'ENH-009':'Verified supplier badge detail (row 93): type, issuer, validity, last checked',
'ENH-017':'RFQ PO approval matrix (row 21): ordered approver and finance stages with maker-checker',
'ENH-023':'Supplier storefront (row 5) with page metadata and structured data',
'ENH-028':'Skeleton states, lazy images, lazy routes and deferred hero globe'};
for(const [id,ev] of Object.entries(E)){let r=s.otherBoxes.find(x=>x.id===id);if(!r){r={id};s.otherBoxes.push(r);}Object.assign(r,{status:'VERIFIED',evidence:ev,verifiedAt:'2026-09-30 (pass 7)'});}
fs.writeFileSync(file,JSON.stringify(s,null,2)+'\n');
