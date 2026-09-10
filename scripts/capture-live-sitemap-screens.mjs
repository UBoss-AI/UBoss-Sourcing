import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outDir = resolve('output/live-sitemap-screenshots');
await mkdir(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function newPage(url) {
  const response = await fetch(
    `http://127.0.0.1:9444/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );
  if (!response.ok) throw new Error(`Could not create page: ${response.status}`);
  return response.json();
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
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
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.ws.close(); }
}

const target = await newPage('http://127.0.0.1:5174');
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
});

async function navigate(url, delay = 1800) {
  await cdp.send('Page.navigate', { url });
  await sleep(delay);
}
async function shot(name) {
  await sleep(500);
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true,
  });
  await writeFile(resolve(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`CAPTURED ${name}`);
}
async function bodyText() {
  return cdp.evaluate('document.body.innerText.slice(0, 4000)');
}
async function fill(selector, value) {
  return cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
}
async function clickMatching(pattern) {
  return cdp.evaluate(`(() => { const re = new RegExp(${JSON.stringify(pattern)}, 'i'); const el = [...document.querySelectorAll('button,[role="button"]')].find((node) => re.test((node.innerText || node.textContent || '').trim()) && !node.disabled); if (!el) return false; el.click(); return true; })()`);
}
async function firstHref(pattern) {
  return cdp.evaluate(`(() => { const re = new RegExp(${JSON.stringify(pattern)}); const a = [...document.querySelectorAll('a[href]')].find((node) => re.test(node.getAttribute('href'))); return a ? a.href : null; })()`);
}

// Public customer screens
await navigate('http://127.0.0.1:5174/');
await shot('01-customer-home');
await navigate('http://127.0.0.1:5174/products');
await shot('02-customer-catalogue');
const productUrl = await firstHref('/product/');
if (!productUrl) throw new Error('A product link was not available in the live catalogue.');
await navigate(productUrl);
await shot('03-customer-product-detail');
await navigate('http://127.0.0.1:5174/login');
await shot('04-customer-login');
console.log('CUSTOMER LOGIN PAGE:', (await bodyText()).slice(0, 600));
console.log('Customer email field:', await fill('input[type="email"]', 'buyer@acme.local'));
console.log('Customer password field:', await fill('input[type="password"]', 'BuyerDev!2026'));
console.log('Customer login click:', await clickMatching('sign in|log in|login'));
await sleep(2500);
await shot('05-customer-after-login');

await navigate(productUrl);
console.log('Add-to-cart click:', await clickMatching('add to cart'));
await sleep(1800);
await shot('06-customer-product-added');
await navigate('http://127.0.0.1:5174/cart');
await shot('07-customer-cart');
console.log('Checkout click:', await clickMatching('checkout'));
await sleep(1800);
await shot('08-customer-checkout');

// Account and scheduled-purchase screens
await navigate('http://127.0.0.1:5174/account/profile');
await shot('09-customer-profile');
await navigate('http://127.0.0.1:5174/account/orders');
await shot('10-customer-orders');
await navigate('http://127.0.0.1:5174/schedules/new');
await shot('11-customer-schedule-builder');

// Staff admin screens
await cdp.send('Browser.grantPermissions', {
  origin: 'http://127.0.0.1:5173',
  permissions: ['geolocation'],
}).catch(() => {});
await cdp.send('Emulation.setGeolocationOverride', {
  latitude: 18.5204, longitude: 73.8567, accuracy: 20,
}).catch(() => {});
await navigate('http://127.0.0.1:5173/login');
await shot('12-admin-login');
console.log('ADMIN LOGIN PAGE:', (await bodyText()).slice(0, 600));
console.log('Admin email field:', await fill('input[type="email"]', 'owner@uboss.local'));
console.log('Admin password field:', await fill('input[type="password"]', 'OwnerDev!2026'));
console.log('Admin login click:', await clickMatching('sign in|log in|login'));
await sleep(3500);
await shot('13-admin-dashboard');

const adminRoutes = [
  ['14-admin-categories', '/categories'],
  ['15-admin-products', '/products'],
  ['16-admin-inventory', '/inventory'],
  ['17-admin-warehouses', '/warehouses'],
  ['18-admin-orders', '/orders'],
  ['19-admin-payments', '/payments'],
  ['20-admin-recurring', '/recurring'],
  ['21-admin-customers', '/customers'],
  ['22-admin-reports', '/reports'],
  ['23-admin-integrations', '/integrations'],
  ['24-admin-staff', '/staff'],
  ['25-admin-settings', '/settings'],
  ['26-admin-audit', '/audit'],
];
for (const [name, path] of adminRoutes) {
  await navigate(`http://127.0.0.1:5173${path}`);
  await shot(name);
}

cdp.close();
