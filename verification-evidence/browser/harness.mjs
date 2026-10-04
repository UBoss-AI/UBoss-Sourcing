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
  if (plan.login) return loginWith(base, plan.login);
  const seed = fs.readFileSync(ROOT + '/backend/src/seed/accounts.ts', 'utf8');
  const m = seed.match(/email:\s*'buyer@acme\.local'[\s\S]*?password:\s*'([^']+)'/);
  if (!m) throw new Error('seed customer not found');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await go(base + '/login');
  await evalJs(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); };
    set(document.querySelector('input[type=email]'), 'buyer@acme.local'); set(document.querySelector('input[autocomplete=current-password]'), ${JSON.stringify(m[1])});
    const cb = document.querySelector('input[type=checkbox]'); if (cb && !cb.checked) cb.click();
    document.querySelector('button[type=submit]').click(); })()`);
  await sleep(4000);
  return evalJs('location.pathname');
}

// plan.login: { path, email, password, hubPath?, hubPassword? } - admin, Seller Hub and
// carrier-portal sweeps; hubPassword is typed into the Seller Hub's own lock.
async function loginWith(base, l) {
  const fill = (pairs) => evalJs(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); };
    ${pairs} const cb = document.querySelector('form input[type=checkbox]'); if (cb && !cb.checked) cb.click(); document.querySelector('button[type=submit]').click(); })()`);
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await go(base + l.path);
  for (let i = 0; i < 40 && !(await evalJs('!!document.querySelector("input[type=email]")')); i++) await sleep(250);
  await fill(`set(document.querySelector('input[type=email]'), ${JSON.stringify(l.email)}); set(document.querySelector('input[type=password]'), ${JSON.stringify(l.password)});`);
  await sleep(4000);
  if (l.hubPath) {
    await go(base + l.hubPath);
    if (await evalJs('!!document.querySelector("input[autocomplete=current-password]")')) { await fill(`set(document.querySelector('input[autocomplete=current-password]'), ${JSON.stringify(l.hubPassword)});`); await sleep(3000); }
  }
  return evalJs('location.pathname');
}

const MEASURE = `(() => { const d = document, cw = d.documentElement.clientWidth, sw = d.documentElement.scrollWidth;
  const over = [...d.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > cw + 1; })
   .filter(e => { let p = e.parentElement; while (p && p !== d.body) { if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return false; p = p.parentElement; } return true; })
   .slice(0, 4).map(e => e.tagName.toLowerCase() + '.' + String(e.className).slice(0, 40) + ' right=' + Math.round(e.getBoundingClientRect().right));
  const smallTargets = [...d.querySelectorAll('a[href],button,input,select,textarea,[role=button]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24) && getComputedStyle(e).visibility !== 'hidden'; }).length;
  return { cw, sw, hScroll: sw > cw, over, smallTargets, h1: [...d.querySelectorAll('h1')].map(h => h.textContent.trim().slice(0, 50)), title: d.title }; })()`;

const results = [];
for (const page of plan.pages) {
  if (page.signIn && !plan._signedIn) { plan._signedIn = await signIn(plan.base); results.push({ signIn: plan._signedIn }); }
  if (page.pathFrom) { await go(plan.base + '/'); page.path = await evalJs(page.pathFrom); results.push({ resolved: page.name, path: page.path }); if (!page.path) continue; }
  for (const w of (page.widths || plan.widths)) {
    await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 768 });
    consoleErrors.length = 0;
    await go(plan.base + page.path);
    if (page.after) { page.afterResult = await evalJs(page.after); }
    const m = await evalJs(MEASURE);
    await evalJs(AXE + ';0');
    const axe = await evalJs(`axe.run(document, { runOnly: ['wcag2a','wcag2aa','wcag21a','wcag21aa'] }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes[0]?.target?.join(' ').slice(0, 80) })))`);
    let focus = null;
    if (w === plan.focusWidth) {
      await evalJs('document.activeElement && document.activeElement.blur(); window.scrollTo(0,0)');
      focus = [];
      for (let i = 0; i < (plan.tabs || 12); i++) {
        await key('Tab', 'Tab', 9); await sleep(80);
        focus.push(await evalJs(`(() => { const e = document.activeElement; if (!e || e === document.body) return 'body'; const s = getComputedStyle(e); const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none');
          return (e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || e.tagName).trim().replace(/\\s+/g,' ').slice(0, 28) + (ring ? '' : ' [NO VISIBLE FOCUS]'); })()`));
      }
    }
    const shot = await cmd('Page.captureScreenshot', { format: 'png' });
    const file = `${page.name}-${w}.png`;
    fs.writeFileSync(`${OUT}/shots/${file}`, Buffer.from(shot.data, 'base64'));
    results.push({ afterResult: page.afterResult, darkClass: await evalJs("document.documentElement.className + '|' + (document.documentElement.dataset.theme||'')"), page: page.name, path: page.path, w, finalPath: await evalJs('location.pathname'), ...m, axe, focus, jsErrors: [...consoleErrors], shot: file });
    process.stdout.write(`${page.name}@${w} hScroll=${m.hScroll} axe=${axe.length}\n`);
  }
}
fs.writeFileSync(OUT + '/results.json', JSON.stringify({ ranAt: new Date().toISOString(), browser: ver.Browser, axe: '4.13.0', results }, null, 1));
ws.close(); proc.kill();
