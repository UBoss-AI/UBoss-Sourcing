const fs=require('fs');const file='verification-evidence/pass4/state.json';const s=JSON.parse(fs.readFileSync(file,'utf8'));
const r=s.rows.find(x=>x.id===89);const t='LandedCostPage.test 2/2 (worked example, rounding, parsing); i18n 67/67; tsc and lint clean';
Object.assign(r,{status:'FIXED_AND_VERIFIED',pass4Done:true,verifiedAt:'2026-09-30 (pass 7)',finding:'No landed cost calculator existed.',fix:'Added public /tools/landed-cost (item, freight, duty, tax, inspection, platform fee; total and per unit; BigInt minor units), linked from the product page. 8 languages.',tests:t,evidence:t,testResult:t,verification:t});
fs.writeFileSync(file,JSON.stringify(s,null,2)+'\n');
