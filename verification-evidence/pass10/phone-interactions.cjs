const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.UBOSS_PHONE_PLAYWRIGHT_MODULE || 'playwright');
const root=process.argv[2] || path.resolve(__dirname,'../..');const dir=path.join(root,'output/pass10-phone');fs.mkdirSync(dir,{recursive:true});
const filename='certificate_of_origin_for_consignment_UB_PHONE_001_renewed_20261003.pdf';
(async()=>{const browser=await chromium.launch({executablePath:process.env.UBOSS_PHONE_BROWSER || undefined,headless:true});const results=[];
try{for(const width of [375,320]){const context=await browser.newContext({viewport:{width,height:812},isMobile:true,hasTouch:true,locale:'en-US',reducedMotion:'reduce'});
await context.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:5197/')?route.continue():route.abort());
for(const flow of ['rfq','milestones','readiness','documents','notifications']){const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:5197/output/phone-preview/index.html?case='+flow,{waitUntil:'networkidle',timeout:45000});
let detail={};
if(flow==='rfq'){
 await page.getByRole('button',{name:'Send the quote',exact:true}).tap();
 assert.equal(await page.evaluate(()=>window.__phoneCalls.filter(c=>c.method!=='GET').length),0,'Invalid quote sent');
 await page.getByLabel(/^Unit price/).fill('4.25');await page.getByLabel(/^Quantity/).fill('100');
 await page.getByLabel(/^Valid until/).fill(new Date(Date.now()+7*86400000).toISOString().slice(0,16));
 await page.getByRole('button',{name:'Send the quote',exact:true}).tap();
 await page.waitForFunction(()=>window.__phoneCalls.some(c=>c.method==='POST'&&c.url.includes('/seller/rfqs/')));
 const call=await page.evaluate(()=>window.__phoneCalls.find(c=>c.method==='POST'&&c.url.includes('/seller/rfqs/')));
 assert.equal(call.body.unitPriceMinor,'425');assert.equal(call.body.quantity,'100');detail={invalidPrevented:true,unitPriceMinor:call.body.unitPriceMinor,quantity:call.body.quantity};
}else if(flow==='milestones'){
 const original=await page.getByTestId('stage-IN_PRODUCTION').evaluate(el=>{const r=el.getBoundingClientRect();return[...el.querySelectorAll('input,button')].map(c=>{const b=c.getBoundingClientRect();return{label:c.getAttribute('aria-label')||c.textContent,parentRight:r.right,right:b.right,inside:b.right<=r.right+1};});});assert.ok(original.every(c=>c.inside),'Milestone controls extend past their card');
 await page.getByLabel('Message to the buyer').fill('Production started');await page.getByLabel('Internal note',{exact:true}).fill('Private workbench note');
 await page.getByRole('button',{name:'Record: In production',exact:true}).tap();
 await page.waitForFunction(()=>window.__phoneCalls.some(c=>c.method==='POST'&&c.url.endsWith('/production/milestones')));
 const call=await page.evaluate(()=>window.__phoneCalls.find(c=>c.method==='POST'&&c.url.endsWith('/production/milestones')));
 assert.equal(call.body.stage,'IN_PRODUCTION');assert.equal(call.body.buyerNote,'Production started');assert.equal(call.body.internalNote,'Private workbench note');detail={recordedStage:call.body.stage,originalControls:original};
}else if(flow==='readiness'){
 const send=page.getByRole('button',{name:'Send readiness',exact:true});assert.equal(await send.isDisabled(),true);
 for(const[label,value]of [['Lot reference','LOT-PHONE-001'],['Where the goods are','Factory receiving dock'],['Contact on site','Asha'],['Contact phone','+919999999990']])await page.getByLabel(label,{exact:true}).fill(value);
 await page.getByText('I confirm the lot, quantity and packing described here are ready for independent inspection.',{exact:true}).tap();
 assert.equal(await send.isEnabled(),true);await send.tap();
 await page.waitForFunction(()=>window.__phoneCalls.some(c=>c.method==='POST'&&c.url.includes('/readiness')));
 const call=await page.evaluate(()=>window.__phoneCalls.find(c=>c.method==='POST'&&c.url.includes('/readiness')));assert.equal(call.body.declaration,true);assert.equal(call.body.lotReference,'LOT-PHONE-001');detail={initialGuard:true,declaration:true,lotReference:call.body.lotReference};
}else if(flow==='documents'){
 await page.getByRole('button',{name:'Save version',exact:true}).tap();assert.equal(await page.evaluate(()=>window.__phoneCalls.filter(c=>c.method!=='GET').length),0,'Document without issuer sent');
 await page.getByLabel(/^Issued by/).fill('Independent chamber');
 await page.getByTestId('trade-doc-file').setInputFiles({name:filename,mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nphone fixture\n%%EOF')});
 detail.beforeSave=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,fileLabel:document.querySelector('[data-testid="trade-doc-file"]').closest('label').getBoundingClientRect().toJSON()}));assert.equal(detail.beforeSave.width,width);assert.equal(detail.beforeSave.documentWidth,width);assert.ok(detail.beforeSave.fileLabel.right<=width,'Long filename clips upload controls');
 await page.screenshot({path:path.join(dir,'documents-long-filename-'+width+'.png'),fullPage:true});
 await page.getByRole('button',{name:'Save version',exact:true}).tap();await page.waitForFunction(()=>window.__phoneCalls.some(c=>c.method==='POST'&&c.url.endsWith('/trade-documents/upload')));
 const call=await page.evaluate(()=>window.__phoneCalls.find(c=>c.method==='POST'&&c.url.endsWith('/trade-documents/upload')));assert.equal(call.body.file.name,filename);assert.equal(call.body.file.size,28);assert.equal(call.body.file.type,'application/pdf');detail.uploadedFile=call.body.file;detail.missingIssuerPrevented=true;
}else{
 await page.getByRole('button',{name:'Mark read',exact:true}).tap();await page.waitForFunction(()=>window.__phoneCalls.some(c=>c.method==='POST'&&c.url.endsWith('/notifications/phone-alert/read')));
 await page.getByText('All caught up.').waitFor({state:'visible',timeout:2000}).catch(()=>{});
 assert.equal(await page.getByRole('button',{name:'Mark read',exact:true}).count(),0);detail={markedOwnNoticeRead:true};
}
assert.deepEqual(errors,[]);results.push({flow,width,detail,errors});await page.close();}await context.close();}
fs.writeFileSync(path.join(dir,'interaction-probe.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));}
finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
