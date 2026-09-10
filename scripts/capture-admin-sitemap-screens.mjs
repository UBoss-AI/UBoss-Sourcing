import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outDir = resolve('output/live-sitemap-screenshots');
await mkdir(outDir, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const response = await fetch('http://127.0.0.1:9444/json/new?http%3A%2F%2F127.0.0.1%3A5173%2Flogin', { method: 'PUT' });
const meta = await response.json();

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
      }
    });
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    return result.result?.value;
  }
}

const cdp = new Cdp(meta.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.clearBrowserCookies');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: 'Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (ok) => ok({ coords: { latitude: 18.5204, longitude: 73.8567, accuracy: 20 } }) } });',
});
await cdp.send('Browser.grantPermissions', { origin: 'http://127.0.0.1:5173', permissions: ['geolocation'] }).catch(() => {});
await cdp.send('Emulation.setGeolocationOverride', { latitude: 18.5204, longitude: 73.8567, accuracy: 20 }).catch(() => {});

async function goto(url, delay = 1800) {
  await cdp.send('Page.navigate', { url });
  await wait(delay);
}
async function shot(name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  await writeFile(resolve(outDir, name + '.png'), Buffer.from(result.data, 'base64'));
  console.log('CAPTURED ' + name);
}
async function fill(selector, value) {
  const expression = '(() => { const e=document.querySelector(' + JSON.stringify(selector) + '); if(!e)return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,' + JSON.stringify(value) + '); e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); return true; })()';
  return cdp.evaluate(expression);
}
async function submit() {
  return cdp.evaluate('(() => { const b=[...document.querySelectorAll("button")].find((e)=>/sign in|log in|login/i.test(e.innerText)&&!e.disabled);if(!b)return false;b.click();return true; })()');
}
async function bodyText() {
  return cdp.evaluate('document.body.innerText.slice(0, 1400)');
}

console.log('ADMIN: login');
await goto('http://127.0.0.1:5173/login');
await shot('12-admin-login');
console.log((await bodyText()).slice(0, 500));
console.log('FIELDS', await fill('input[type="email"]', 'owner@uboss.local'), await fill('input[type="password"]', 'OwnerDev!2026'));
console.log('SUBMIT', await submit());
await wait(3000);
console.log('ADMIN AFTER LOGIN', (await bodyText()).slice(0, 700));
await shot('13-admin-dashboard');

const screens = [
  ['26-admin-settings', '/settings'],
  ['27-admin-erp-settings', '/settings/erp'],
  ['28-admin-audit', '/audit'],
];
for (const [name, path] of screens) {
  await goto('http://127.0.0.1:5173' + path);
  await shot(name);
}
