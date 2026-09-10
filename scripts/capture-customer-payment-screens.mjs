import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outDir = resolve('output/live-sitemap-screenshots');
await mkdir(outDir, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const response = await fetch('http://127.0.0.1:9444/json/new?http%3A%2F%2F127.0.0.1%3A5174%2Flogin', { method: 'PUT' });
const meta = await response.json();

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url); this.nextId = 1; this.pending = new Map();
    this.ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id); this.pending.delete(message.id);
        message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
      }
    });
  }
  async open() { await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); }); }
  send(method, params = {}) { const id=this.nextId++; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  async evaluate(expression) { const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true}); return result.result?.value; }
}
const cdp = new Cdp(meta.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.clearBrowserCookies');
await cdp.send('Emulation.setDeviceMetricsOverride', { width:1440, height:1000, deviceScaleFactor:1, mobile:false });

async function goto(url, delay = 1800) { await cdp.send('Page.navigate', { url }); await wait(delay); }
async function shot(name) {
  const result = await cdp.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false, fromSurface:true });
  await writeFile(resolve(outDir, name + '.png'), Buffer.from(result.data, 'base64'));
  console.log('CAPTURED ' + name);
}
async function fill(selector, value) {
  return cdp.evaluate('(() => { const e=document.querySelector(' + JSON.stringify(selector) + ');if(!e)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,' + JSON.stringify(value) + ');e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return true; })()');
}
async function clickButton(pattern) {
  return cdp.evaluate('(() => { const re=new RegExp(' + JSON.stringify(pattern) + ',"i");const b=[...document.querySelectorAll("button")].find((e)=>re.test(e.innerText)&&!e.disabled);if(!b)return false;b.click();return true; })()');
}
async function location() { return cdp.evaluate('location.href'); }

await goto('http://127.0.0.1:5174/login');
await fill('input[type="email"]', 'buyer@acme.local');
await fill('input[type="password"]', 'BuyerDev!2026');
console.log('LOGIN', await clickButton('sign in|log in|login'));
await wait(2500);
await goto('http://127.0.0.1:5174/cart');
await shot('07-customer-cart');
console.log('CHECKOUT', await clickButton('proceed to checkout|checkout'));
await wait(1800);
await shot('08-customer-checkout');
console.log('PLACE ORDER', await clickButton('place order and pay'));
await wait(4500);
console.log('AFTER PLACE ORDER:', await location());
await shot('29-customer-payment-step');
await goto('http://127.0.0.1:5174/schedules/new');
await shot('11-customer-schedule-builder');

