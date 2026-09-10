import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outDir = resolve('output/live-sitemap-screenshots');
await mkdir(outDir, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const response = await fetch('http://127.0.0.1:9444/json/new?http%3A%2F%2F127.0.0.1%3A5174%2Faccount%2Fprofile', { method: 'PUT' });
const meta = await response.json();
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url); this.nextId = 1; this.pending = new Map();
    this.ws.addEventListener('message', ({data}) => { const m=JSON.parse(data); if(m.id && this.pending.has(m.id)){const p=this.pending.get(m.id);this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);} });
  }
  async open(){await new Promise((resolve,reject)=>{this.ws.addEventListener('open',resolve,{once:true});this.ws.addEventListener('error',reject,{once:true});});}
  send(method,params={}){const id=this.nextId++;this.ws.send(JSON.stringify({id,method,params}));return new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}));}
}
const cdp = new Cdp(meta.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
async function goto(url){await cdp.send('Page.navigate',{url});await wait(1500);}
async function shot(name){const r=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true});await writeFile(resolve(outDir,name+'.png'),Buffer.from(r.data,'base64'));console.log('CAPTURED '+name);}

const screens = [
 ['30-customer-register','/register'], ['31-customer-activate','/activate'], ['32-customer-forgot-password','/forgot-password'],
 ['33-customer-company','/account/company'], ['34-customer-addresses','/account/addresses'], ['35-customer-region','/account/region'],
 ['36-customer-payment-methods','/account/payment-methods'], ['37-customer-autopay','/account/autopay'], ['38-customer-billing','/account/billing'],
 ['39-customer-erp','/account/erp'], ['40-customer-coupons','/account/coupons'], ['41-customer-wishlist','/account/wishlist'],
 ['42-customer-notifications','/account/notifications']
];
for(const [name,path] of screens){await goto('http://127.0.0.1:5174'+path);await shot(name);}

