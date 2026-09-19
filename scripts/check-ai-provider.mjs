/**
 * Is the AI this deployment is configured for actually answering?
 *
 *     cd scripts && npm run check:ai
 *
 * Every AI surface in this product — the storefront assistant, AI Mode, image
 * search and the insights panel on the three dashboards — goes through one
 * provider seam, so one live call answers for all of them.
 *
 * ---
 *
 * WHY THIS SCRIPT EXISTS AT ALL
 *
 * Because the product is *designed* not to break when the provider is down.
 * The insights panel falls back to a deterministic summary, says so on screen,
 * and carries on; the assistant widget simply does not mount. That is the right
 * behaviour and it is also why a broken key can sit unnoticed for weeks: there
 * is no red screen, no failed request in the console, nothing but a slightly
 * duller dashboard. This is the thing that goes and looks.
 *
 * It reports the three failures separately, because they are three different
 * problems with three different fixes:
 *
 *   1. **No key.** Not a fault. The software ships this way and the deterministic
 *      fallback is doing its job.
 *   2. **The key is refused.** Revoked, wrong project, or billing off.
 *   3. **The model is gone, or out of quota.** The common one. Google's free
 *      tier is metered PER MODEL, so a model that worked yesterday answers 429
 *      today while every other model on the same key is fine — see the note in
 *      `backend/.env.example`. The script lists the models that do answer, so
 *      the fix is one line of `.env` away.
 *
 * NOTHING IS PRINTED THAT SHOULD NOT BE. The key is reported as present or
 * absent and by length, never by value, because this output goes into terminals,
 * CI logs and screenshots.
 *
 * It reads `backend/.env` directly rather than importing the config module: the
 * question is what the SERVER is configured with, and a script that booted the
 * whole config to ask would fail for reasons that have nothing to do with AI.
 *
 * Exit codes, so a scheduler can read it without parsing prose:
 *
 *   0  the provider answered
 *   1  configured but not working — a fault
 *   2  no provider configured — the documented default, not a fault
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(REPO, 'backend', '.env');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

/** How long to wait before calling the provider unreachable. */
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Reading the configuration
// ---------------------------------------------------------------------------

/**
 * The server's environment, as the server reads it.
 *
 * Deliberately not a dotenv parser. `.env` here is flat `NAME=value` lines and
 * comments; anything cleverer would be a second opinion about a file the server
 * already has the only opinion that matters on.
 */
function readEnv() {
  let raw;
  try {
    raw = readFileSync(ENV_FILE, 'utf8');
  } catch {
    fail(`Could not read ${ENV_FILE}. Copy backend/.env.example to backend/.env first.`);
    process.exit(1);
  }

  const entries = raw
    .split(/\r?\n/)
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1).trim()];
    });

  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Saying what happened
// ---------------------------------------------------------------------------

const useColour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code, text) => (useColour ? `[${code}m${text}[0m` : text);

const ok = (text) => console.log(`  ${paint('32', 'OK  ')}  ${text}`);
const warn = (text) => console.log(`  ${paint('33', 'WARN')}  ${text}`);
const fail = (text) => console.log(`  ${paint('31', 'FAIL')}  ${text}`);
const note = (text) => console.log(`        ${text}`);

/** A key, described without being disclosed. */
function describeKey(value) {
  return value === '' ? 'not set' : `set (${String(value.length)} characters)`;
}

async function withTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The first line of a provider's error, which is the part worth reading.
 *
 * Google's 429 body in particular is a wall of quota metric names and help
 * links; the first sentence says the thing, and the rest is noise in a terminal.
 */
function firstLine(text) {
  return String(text).split('\n')[0].trim().slice(0, 160);
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

async function checkGemini(key, model) {
  const headers = { 'x-goog-api-key': key, 'Content-Type': 'application/json' };

  // --- Does the key work, and what may it use? ---------------------------
  let usable = [];
  try {
    const response = await withTimeout(`${GEMINI_BASE}/models?pageSize=200`, { headers });

    if (!response.ok) {
      fail(`The key was refused — HTTP ${String(response.status)}.`);
      note(firstLine(await response.text()));
      note('Check the key at https://aistudio.google.com/apikey, and that billing is on.');
      return 1;
    }

    const body = await response.json();
    usable = (body.models ?? [])
      .filter((entry) => (entry.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((entry) => String(entry.name).replace(/^models\//, ''));

    ok(`The key works. ${String(usable.length)} models are available to it.`);
  } catch (error) {
    fail(`Could not reach the provider — ${String(error)}`);
    return 1;
  }

  // --- Is the configured model one of them? ------------------------------
  if (!usable.includes(model)) {
    fail(`GEMINI_MODEL is "${model}", which this key cannot use.`);
    note(`Available: ${suggest(usable).join(', ')}`);
    note('Set GEMINI_MODEL in backend/.env to one of those and restart the API.');
    return 1;
  }

  // --- Does it answer? ---------------------------------------------------
  const started = Date.now();

  try {
    const response = await withTimeout(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ready' }] }],
        // Generous, because a reasoning model spends tokens before it writes a
        // word and a tight cap here would report a working provider as broken.
        generationConfig: { maxOutputTokens: 512, temperature: 0 },
      }),
    });

    const took = Date.now() - started;

    if (response.status === 429) {
      fail(`"${model}" is out of quota (HTTP 429, after ${String(took)}ms).`);
      note(firstLine((await response.json().catch(() => ({}))).error?.message ?? ''));
      note('Google meters the free tier PER MODEL, so another model on this same');
      note('key will usually answer. Change GEMINI_MODEL in backend/.env and');
      note('restart the API, or enable billing on the Google Cloud project.');
      note(`Others available: ${suggest(usable.filter((name) => name !== model)).join(', ')}`);
      return 1;
    }

    if (!response.ok) {
      fail(`"${model}" did not answer — HTTP ${String(response.status)} after ${String(took)}ms.`);
      note(firstLine(await response.text()));
      return 1;
    }

    const body = await response.json();
    const text = (body.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    if (text === '') {
      // A 200 with nothing in it is a real state — a safety block, or a reply
      // that spent its whole budget on reasoning. It is not a working provider.
      fail(`"${model}" answered with nothing (HTTP 200 after ${String(took)}ms).`);
      note(`finishReason: ${String(body.candidates?.[0]?.finishReason ?? 'unknown')}`);
      return 1;
    }

    ok(`"${model}" answered in ${String(took)}ms — ${JSON.stringify(text.slice(0, 60))}`);
    return 0;
  } catch (error) {
    fail(`"${model}" did not answer — ${String(error)}`);
    return 1;
  }
}

/** The handful of model names worth printing, newest first. */
function suggest(names) {
  const flash = names.filter((name) => name.includes('flash')).sort().reverse();
  return (flash.length > 0 ? flash : names).slice(0, 8);
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function checkAnthropic(key, model) {
  const started = Date.now();

  try {
    const response = await withTimeout(`${ANTHROPIC_BASE}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      }),
    });

    const took = Date.now() - started;

    if (!response.ok) {
      const body = await response.text();
      fail(`"${model}" did not answer — HTTP ${String(response.status)} after ${String(took)}ms.`);
      note(firstLine(body));
      if (response.status === 401) note('The key was refused. Check it in the Anthropic Console.');
      if (response.status === 429) note('Rate limited or out of credit. Check the plan on the key.');
      if (response.status === 404) note('That model name is not one this key can use.');
      return 1;
    }

    const body = await response.json();
    const text = (body.content ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    ok(`"${model}" answered in ${String(took)}ms — ${JSON.stringify(text.slice(0, 60))}`);
    return 0;
  } catch (error) {
    fail(`"${model}" did not answer — ${String(error)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

const env = readEnv();

const enabled = (env.ASSISTANT_ENABLED ?? 'true').toLowerCase() !== 'false';
const chosen = env.ASSISTANT_PROVIDER ?? '';
const geminiKey = env.GEMINI_API_KEY ?? '';
const geminiModel = env.GEMINI_MODEL === undefined || env.GEMINI_MODEL === '' ? 'gemini-2.5-flash' : env.GEMINI_MODEL;
const anthropicKey = env.ANTHROPIC_API_KEY ?? '';
const anthropicModel = env.ANTHROPIC_MODEL === undefined || env.ANTHROPIC_MODEL === '' ? 'claude-opus-5' : env.ANTHROPIC_MODEL;

console.log('');
console.log(paint('1', 'UBOSS AI provider check'));
console.log(`${new Date().toISOString()}  ·  backend/.env`);
console.log('');
console.log(`  ASSISTANT_ENABLED   ${String(enabled)}`);
console.log(`  ASSISTANT_PROVIDER  ${chosen === '' ? '(blank — whichever key is set)' : chosen}`);
console.log(`  GEMINI_API_KEY      ${describeKey(geminiKey)}`);
console.log(`  GEMINI_MODEL        ${geminiModel}`);
console.log(`  ANTHROPIC_API_KEY   ${describeKey(anthropicKey)}`);
console.log(`  ANTHROPIC_MODEL     ${anthropicModel}`);
console.log('');

if (!enabled) {
  warn('ASSISTANT_ENABLED is false. Every AI surface is switched off deliberately.');
  console.log('');
  process.exit(2);
}

/*
 * Which provider the server would pick.
 *
 * Mirrors the seam's own rule: an explicit ASSISTANT_PROVIDER wins, otherwise
 * whichever key is set, and Gemini first where both are. This has to agree with
 * the server or the script tests something the product does not use.
 */
let provider = chosen;
if (provider === '') provider = geminiKey !== '' ? 'gemini' : anthropicKey !== '' ? 'anthropic' : '';

if (provider === '') {
  warn('No AI provider is configured. This is how the software ships.');
  note('Every AI surface falls back honestly: the insights panel builds its');
  note('summary from your own figures and says so, and the assistant widget');
  note('does not mount. Set GEMINI_API_KEY or ANTHROPIC_API_KEY to switch it on.');
  console.log('');
  process.exit(2);
}

const key = provider === 'gemini' ? geminiKey : anthropicKey;

if (key === '') {
  fail(`ASSISTANT_PROVIDER is "${provider}" but its key is not set.`);
  note('The server will find no provider and fall back for every request.');
  console.log('');
  process.exit(1);
}

console.log(`  Checking ${provider}…`);
console.log('');

const code =
  provider === 'gemini'
    ? await checkGemini(geminiKey, geminiModel)
    : await checkAnthropic(anthropicKey, anthropicModel);

console.log('');
console.log(
  code === 0
    ? paint('32', '  The AI is up. The assistant, AI Mode, image search and the insights')
    : paint('31', '  The AI is NOT working. Every AI surface is running on its fallback:'),
);
console.log(
  code === 0
    ? '  panels on all three dashboards are answering from the provider.'
    : '  honest, but duller. Fix the above and restart the API.',
);
console.log('');

process.exit(code);
