// UAT-UI-015: a low-bandwidth mobile session. Headless Chrome over CDP, 375px mobile,
// network throttled to a slow-3G profile. Records when the search box and a product
// control first exist, and whether the three.js globe chunks were ever requested.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9338, BASE = process.env.BASE || 'http://127.0.0.1:4174';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = (await import('node:path')).resolve('./profile-lowband');
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
let ver; for (let i = 0; i < 150; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map(); const listeners = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); } else listeners.forEach((l) => l(d)); };
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

async function run(label, throttle) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cmd = (m, p) => send(m, p, S);
  await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('Network.enable');
  await cmd('Network.setCacheDisabled', { cacheDisabled: true });
  await cmd('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await cmd('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: 8 }).catch(() => {});
  if (throttle) await cmd('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8, connectionType: 'cellular3g' });
  const urls = [];
  listeners.push((d) => { if (d.sessionId === S && d.method === 'Network.requestWillBeSent') urls.push(d.params.request.url); });
  const eval_ = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true })).result.value;
  const t0 = Date.now();
  await cmd('Page.navigate', { url: BASE + '/' });
  let searchAt = null, productsAt = null, canvasAt = null;
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    const s = await eval_(`({ search: !!document.querySelector('#hero-search-input'), products: !!document.querySelector('a[href^="/products"]'), canvas: !!document.querySelector('canvas'), conn: navigator.connection ? navigator.connection.effectiveType : null })`).catch(() => ({}));
    const t = Date.now() - t0;
    if (s.search && searchAt === null) searchAt = t;
    if (s.products && productsAt === null) productsAt = t;
    if (s.canvas && canvasAt === null) canvasAt = t;
    if (searchAt !== null && (i > 80 || canvasAt !== null)) { var conn = s.conn; break; }
  }
  const globe = urls.filter((u) => /EarthScene|3d-globe|three|fiber|drei|earth-blue-marble|Globe/i.test(u)).map((u) => u.replace(BASE, '').split('?')[0]);
  const shot = await cmd('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`shots-lowband-${label}.png`, Buffer.from(shot.data, 'base64'));
  await send('Target.closeTarget', { targetId });
  return { label, throttled: throttle, effectiveType: conn, searchVisibleMs: searchAt, productsLinkMs: productsAt, canvasMs: canvasAt, globeRequests: globe.length, globeSample: globe.slice(0, 4) };
}
const out = [await run('normal', false), await run('slow3g', true)];
fs.writeFileSync('results-lowband.json', JSON.stringify({ ranAt: new Date().toISOString(), browser: ver.Browser, out }, null, 1));
console.log(JSON.stringify(out, null, 1));
ws.close(); proc.kill();
