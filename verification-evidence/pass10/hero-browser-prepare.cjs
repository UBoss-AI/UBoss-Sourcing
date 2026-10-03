const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');const root=path.resolve(process.argv[2]);
cp.execFileSync(process.execPath,[path.join(root,'verification-evidence/pass10/search-browser-prepare.cjs'),root]);
const p=path.join(root,'apps/customer-web/output/search-preview/main.tsx.preview');let s=fs.readFileSync(p,'utf8');
s="import {SupplierDirectoryPage} from '../../src/pages/SupplierDirectoryPage';\nimport {RfqEditPage} from '../../src/pages/rfq/RfqEditPage';\n"+s;
s=s.replace('user:null,isLoading:false,isCustomer:false','user:{id:"buyer-preview",email:"buyer@example.test",type:"CUSTOMER",roles:[],permissions:[],customerProfileId:"profile-preview",mfaEnabled:false},isLoading:false,isCustomer:true');
s=s.replace('assistant:false,imageSearch:false','assistant:true,imageSearch:true,rfq:true');
const options=fs.readFileSync(path.join(root,'apps/customer-web/src/pages/rfq/RfqPages.test.tsx'),'utf8');const fixture=options.slice(options.indexOf('const OPTIONS ='),options.indexOf('function rfq('));assert.ok(fixture.includes('attachments:'));s=s.replace('const noop=()=>{};',fixture+'\nconst noop=()=>{};');
const anchor=" if(url.includes('/catalog/search'))";assert.ok(s.includes(anchor));s=s.replace(anchor,` if(url.includes('/form-options'))return json(OPTIONS);
 if(url.includes('/catalog/suppliers')){const q=new URL(url).searchParams.get('q')??'';if(q==='retry'&&++retries===1)return json({error:{code:'UNAVAILABLE',message:'Unavailable'}},503);return json({suppliers:q==='nomatch'?[]:[{slug:'gloves-maker',displayName:'Gloves manufacturer',kind:'MANUFACTURER',registrationCountry:'IN',verifiedAt:'2026-01-01T00:00:00Z',productCount:2,logoUrl:null}],countries:[{country:'IN',count:1}],total:q==='nomatch'?0:1});}
`+anchor);
s=s.replace('<Route path="/products"', '<Route path="/suppliers" element={<SupplierDirectoryPage/>}/><Route path="/account/rfqs/new" element={<RfqEditPage/>}/><Route path="/products"');
fs.writeFileSync(p,s);console.log('Prepared actual hero, supplier destination and editable RFQ with public/error fixtures.');
