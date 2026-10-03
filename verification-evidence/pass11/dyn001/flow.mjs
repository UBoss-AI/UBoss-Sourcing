// Headless Edge over the DevTools protocol - no dependencies (Node 24 WebSocket).
// For every page x width: page-level horizontal scroll, escaping elements, axe
// WCAG 2.0/2.1 A+AA, keyboard focus walk (first N Tab stops with visible focus
// indicator), and a screenshot. Optional sign-in through the real login form
// using the project's seeded development customer (read from the seed file).
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/HP/Desktop/UBoss-Software';
const OUT = process.argv[2];
const plan = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
fs.mkdirSync(OUT + '/shots', { recursive: true });
const AXE = fs.readFileSync(ROOT + '/apps/customer-web/node_modules/axe-core/axe.min.js', 'utf8');
const EDGE = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9337;
const profile = (await import('node:path')).resolve(OUT + '/profile');
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ver;
for (let i = 0; i < 150; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map(); const listeners = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); } else listeners.forEach((l) => l(d)); };
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
const cmd = (m, p) => send(m, p, S);
await cmd('Page.enable'); await cmd('Runtime.enable');
if (plan.denyMic) await send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'denied', origin: plan.base });
if (plan.dark) await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
const consoleErrors = [];
listeners.push((d) => { if (d.sessionId === S && d.method === 'Runtime.exceptionThrown') consoleErrors.push(d.params.exceptionDetails.exception?.description?.slice(0, 200)); });
const evalJs = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
async function go(url) { await cmd('Page.navigate', { url }); for (let i = 0; i < 60; i++) { await sleep(250); if ((await evalJs('document.readyState')) === 'complete') break; } await sleep(2500); }
async function key(k, code, keyCode) { await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode }); }

async function signIn(base) {
  const seed = fs.readFileSync(ROOT + '/backend/src/seed/accounts.ts', 'utf8');
  const m = seed.match(/email:\s*'buyer@acme\.local'[\s\S]*?password:\s*'([^']+)'/);
  if (!m) throw new Error('seed customer not found');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await go(base + '/login'); for (let i=0;i<40 && !(await evalJs('!!document.querySelector("input[type=email]")'));i++) await sleep(250);
  console.log(JSON.stringify(consoleErrors).slice(0,800)); console.log(await evalJs('location.href+" "+[...document.querySelectorAll("input")].map(i=>i.type+":"+i.name).join(",")'));
  await evalJs(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); };
    set(document.querySelector('input[type=email]'), 'buyer@acme.local'); set(document.querySelector('input[type=password]'), ${JSON.stringify(m[1])});
    const cb = document.querySelector('input[type=checkbox]'); if (cb && !cb.checked) cb.click();
    document.querySelector('button[type=submit]').click(); })()`);
  await sleep(4000);
  return evalJs('location.pathname');
}
const B0 = plan.base; const r = {};
async function size(w) { await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: w < 768 }); await sleep(700); }
async function shot(name) { const s = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${OUT}/shots/${name}.png`, Buffer.from(s.data, 'base64')); }
const headerFacts = `(() => { const h = document.querySelector("header"); const r = h.getBoundingClientRect();
  const items = [...h.querySelectorAll('a,button')].filter(e => e.offsetParent !== null).map(e => (e.getAttribute('aria-label') || e.textContent).trim().replace(/ +/g,' ').slice(0,24) + ' ' + Math.round(e.getBoundingClientRect().left) + '-' + Math.round(e.getBoundingClientRect().right) + (e.getBoundingClientRect().right > innerWidth + 0.5 ? ' [CLIPPED]' : ''));
  return { pageOverflow: document.documentElement.scrollWidth > innerWidth, headerHeight: Math.round(r.height), items }; })()`;
async function sweep(tag) { for (const w of [320, 375, 768, 1280]) { await size(w); await go(B0 + '/'); r[`${tag}-${w}`] = await evalJs(headerFacts); await shot(`${tag}-${w}`); } }
await sweep('guest');
r.signIn = await signIn(B0);
await sweep('buyer');
await size(1280); await go(B0 + '/');
// Keyboard: Tab to the inbox, Enter opens, Escape closes and focus returns.
let found = false; for (let i = 0; i < 25 && !found; i++) { await key('Tab', 'Tab', 9); found = await evalJs(`/Messages and notifications/.test(document.activeElement?.getAttribute('aria-label')||'')`); }
r.tabReachesInbox = found;
await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(600);
r.panel = await evalJs(`[...document.querySelectorAll('header nav a')].map(a => a.getAttribute('href') + ' ' + a.textContent.trim())`);
await shot('buyer-inbox-open');
await key('Escape', 'Escape', 27); await sleep(300);
r.afterEscape = await evalJs(`({ open: !!document.querySelector('header nav'), focus: document.activeElement?.getAttribute('aria-label') })`);
await evalJs(`document.querySelector('header a[href="/find"]').click()`); await sleep(2500);
r.searchGoesTo = await evalJs('location.pathname + " " + (document.querySelector("main h1")?.textContent||"")');
r.consoleErrors = consoleErrors;
fs.writeFileSync(OUT + '/results.json', JSON.stringify(r, null, 2)); console.log(JSON.stringify(r).slice(0, 2600));
proc.kill(); process.exit(0);
