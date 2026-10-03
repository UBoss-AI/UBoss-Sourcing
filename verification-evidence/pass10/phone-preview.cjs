const fs=require('node:fs'),path=require('node:path');
const root=process.argv[2],app=path.join(root,'apps/customer-web'),dir=path.join(app,'output/phone-preview');
const ts=require(path.join(app,'node_modules/typescript'));
function declaration(file,name){const source=fs.readFileSync(path.join(app,'src',file),'utf8');const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);for(const node of ast.statements){if(ts.isFunctionDeclaration(node)&&node.name?.text===name)return node.getText(ast);if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(ast)===name))return node.getText(ast);}throw Error('Missing canonical fixture '+name);}
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>');
fs.writeFileSync(path.join(dir,'main.tsx'),`import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {I18nextProvider} from 'react-i18next';
import '../../src/index.css';
import {i18n} from '../../src/i18n/config';
import {ThemeProvider} from '../../src/app/ThemeProvider';
import {StorefrontContext,FALLBACK_CONFIG} from '../../src/app/storefront-context';
import {SessionContext} from '../../src/auth/session-context';
import {LocaleContext} from '../../src/app/locale-context';
import {ToastProvider} from '../../src/components/toast';
import {Card} from '../../src/components/ui';
import {QuoteForm} from '../../src/components/rfq/QuoteForm';
import {EMPTY_REQUIREMENT} from '../../src/lib/rfq';
import {SellerProductionPanel} from '../../src/pages/seller/SellerProductionPanel';
import {InspectionPanel} from '../../src/components/inspection/InspectionPanel';
import {TradeDocumentsPanel} from '../../src/pages/seller/TradeDocumentsPanel';
import {SellerNotificationsPage} from '../../src/pages/seller/SellerNotificationsPage';
${declaration('pages/seller/SellerProductionPanel.test.tsx','production')}
${declaration('components/inspection/InspectionPanel.test.tsx','view')}
const noop=()=>{};
const session={user:{id:'phone-user',email:'seller@example.test',type:'CUSTOMER',roles:['customer'],permissions:[],customerProfileId:'phone-profile',mfaEnabled:false},isLoading:false,isCustomer:true,login:async()=>({next:'READY',mfaChallengeRequired:false}),logout:noop,refreshUser:noop,buyerContext:{kind:'INDIVIDUAL'},companies:[],switchBuyerContext:async()=>{}};
const locale={currency:'INR',country:'IN',currencies:[{code:'INR',name:'Indian rupee',exponent:2,symbol:'₹',isActive:true}],countries:[],needsChoice:false,detectedCountry:null,detectedMismatch:false,marketSuggestion:null,choose:noop,dismissChoice:noop,setCurrency:noop,acceptSuggestion:noop,dismissSuggestion:noop};
const notification={id:'phone-alert',kind:'DISPATCH_SLA_WARNING',title:'Dispatch deadline approaching',body:'Complete the packing list and arrange pickup for order UB-PHONE-001.',linkPath:'/seller/orders/PHONE',severity:'WARNING',notificationClass:'ALERT',status:'ACTIVE',resolvedAt:null,createdAt:new Date().toISOString(),isRead:false,priority:'HIGH',family:'seller.essential'};
let notifiedRead=false;
(window as any).__phoneCalls=[];
globalThis.fetch=async(input:any,init:any={})=>{
 const url=String(input instanceof Request?input.url:input),method=init.method??'GET';
 const body=init.body instanceof FormData?Object.fromEntries([...init.body.entries()].map(([k,v])=>[k,v instanceof File?{name:v.name,size:v.size,type:v.type}:v])):typeof init.body==='string'?JSON.parse(init.body):null;
 (window as any).__phoneCalls.push({url,method,body});
 let data:any;
 if(method!=='GET'){
   if(url.includes('/notifications/')&&url.endsWith('/read'))notifiedRead=true;
   if(!(url.includes('/seller/orders/PHONE/production/')||url.includes('/seller/rfqs/')||url.includes('/inspection/')||url.includes('/trade-documents')||url.includes('/notifications/')))throw Error('Unexpected fixture write '+url);
   data={};
 }else if(url.endsWith('/production'))data=production();
 else if(url.includes('/trade-documents'))data={documents:[],required:[{kind:'CERTIFICATE_OF_ORIGIN',name:'Certificate of origin',ruleName:'Destination evidence',note:'Upload the current document for this shipment.',satisfied:false}],issued:{commercialInvoices:1,packingLists:1},consignments:[]};
 else if(url.endsWith('/seller/notifications'))data={notifications:[{...notification,isRead:notifiedRead}]};
 else if(url.includes('/notification-preferences'))data={families:[]};
 else throw Error('Unexpected fixture read '+url);
 return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
};
document.cookie='uboss_shop_csrf=phone-fixture; path=/';
const selected=new URLSearchParams(location.search).get('case')??'rfq';
const readiness={...view,requirement:{...view.requirement,status:'BOOKED'},jobs:[{...view.jobs[0],status:'ACCEPTED',readinessSubmittedAt:null,report:null,defects:[]}],timeline:[]};
const content=selected==='rfq'?<Card title="Reply to request for quotation" bodyClassName="px-6 py-5"><QuoteForm rfqId="PHONE" requirement={{...EMPTY_REQUIREMENT,title:'Nitrile gloves',quantity:'12000',destinationCountry:'IN',incoterm:'CIF'}} filesAvailable={false}/></Card>:selected==='milestones'?<SellerProductionPanel sellerOrderId="PHONE"/>:selected==='readiness'?<InspectionPanel view={readiness} audience="SELLER" queryKey={['phone-readiness']}/>:selected==='documents'?<TradeDocumentsPanel sellerOrderId="PHONE" canAct/>:<SellerNotificationsPage/>;
const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
createRoot(document.getElementById('root')!).render(<ThemeProvider><I18nextProvider i18n={i18n}><QueryClientProvider client={client}><StorefrontContext.Provider value={FALLBACK_CONFIG}><ToastProvider><SessionContext.Provider value={session as any}><LocaleContext.Provider value={locale as any}><MemoryRouter><main id="phone-surface" className="mx-auto max-w-4xl p-4">{content}</main></MemoryRouter></LocaleContext.Provider></SessionContext.Provider></ToastProvider></StorefrontContext.Provider></QueryClientProvider></I18nextProvider></ThemeProvider>);
`);
console.log(JSON.stringify({preview:dir,canonicalFixtures:['SellerProductionPanel.test.tsx:production','InspectionPanel.test.tsx:view'],sourceFilesChanged:0}));
