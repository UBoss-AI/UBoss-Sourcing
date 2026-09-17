/**
 * Guards on the streamed half of an insight.
 *
 * The panel shows prose as it arrives and the findings only once the stream
 * closes, and the whole reason that is safe is the split in `streamInsight`:
 * everything before the marker is forwarded, everything after it is buffered,
 * parsed and sanitised. These tests hold that seam, because the ways it breaks
 * are all invisible on a healthy dataset:
 *
 *   - a marker arriving across two chunks, so `---DET` reaches the reader;
 *   - JSON leaking into the visible summary;
 *   - a citation being shown before it has been checked;
 *   - a provider failure after several sentences are already on screen.
 *
 * The provider is stubbed rather than called. What is under test is the
 * splitting and the validation around the call, not Gemini.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantRequest, AssistantResult } from '../../src/modules/assistant/provider.js';
import { AssistantBusyError } from '../../src/modules/assistant/provider.js';

/**
 * The provider seam, replaced.
 *
 * `streamInsight` resolves its provider through `activeProvider()`, so that is
 * the one thing mocked — the request building, the split, the parse and the
 * sanitise are all the real code.
 */
const emit = vi.fn<(request: AssistantRequest) => Promise<AssistantResult>>();

vi.mock('../../src/modules/assistant/assistant.service.js', () => ({
  activeProvider: () => ({
    name: 'gemini' as const,
    model: 'stub-model',
    stream: emit,
    describeImage: vi.fn(),
  }),
}));

const { streamInsight } = await import('../../src/modules/assistant/insights.service.js');

const METRICS = [
  {
    key: 'orders.actionRequired',
    label: 'Orders awaiting payment',
    value: 5,
    unit: 'orders',
    severity: 'urgent' as const,
    href: '/account/orders',
  },
  {
    key: 'orders.total',
    label: 'Orders placed',
    value: 11,
    unit: 'orders',
    severity: 'info' as const,
    href: '/account/orders',
  },
];

function request() {
  return {
    audience: 'BUYER' as const,
    window: { from: '2026-08-18T00:00:00.000Z', to: '2026-09-17T00:00:00.000Z' },
    filters: {},
    metrics: METRICS,
  };
}

/** Drive the stubbed provider with a fixed list of chunks. */
function replies(chunks: string[]): void {
  // `Promise.resolve` rather than an `async` arrow: the stub awaits nothing,
  // and the lint rule that objects to that is right — an async function with no
  // await hides whether the caller is actually being made to wait.
  emit.mockImplementation((assistantRequest) => {
    for (const chunk of chunks) assistantRequest.onText(chunk);

    return Promise.resolve({
      finishReason: 'stop',
      refused: false,
      model: 'stub-model',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
    });
  });
}

const DETAIL = JSON.stringify({
  findings: [
    {
      title: 'Five orders awaiting payment',
      detail: 'They cannot progress until they are paid.',
      severity: 'urgent',
      evidence: ['orders.actionRequired'],
    },
  ],
  suggestedActions: [
    { label: 'Review unpaid orders', detail: 'Five are waiting.', metricKey: 'orders.actionRequired' },
  ],
});

beforeEach(() => {
  emit.mockReset();
});

describe('streamInsight', () => {
  it('forwards the prose and never a character of the detail', async () => {
    replies(['Five orders are ', 'awaiting payment.', `\n---DETAIL---\n${DETAIL}`]);

    const deltas: string[] = [];
    const insight = await streamInsight(request(), (text) => deltas.push(text));

    const shown = deltas.join('');

    expect(shown).toContain('Five orders are awaiting payment.');
    // The two ways the seam leaks, asserted directly.
    expect(shown).not.toContain('---DETAIL---');
    expect(shown).not.toContain('findings');
    expect(shown).not.toContain('{');

    expect(insight.summary).toBe('Five orders are awaiting payment.');
    expect(insight.source).toBe('model');
  });

  it('holds back a marker split across two chunks', async () => {
    /*
     * The failure this exists for. A provider chunks wherever it likes, so
     * `---DET` and `AIL---` arriving separately is ordinary — and a naive
     * forward-everything-so-far would put `---DET` on screen and leave it
     * there, because the next chunk completes a marker that has already gone.
     */
    replies(['All clear this period.', '\n---DET', `AIL---\n${DETAIL}`]);

    const deltas: string[] = [];
    await streamInsight(request(), (text) => deltas.push(text));

    const shown = deltas.join('');

    expect(shown).toContain('All clear this period.');
    expect(shown).not.toContain('---DET');
    expect(shown.trim()).toBe('All clear this period.');
  });

  it('delivers the summary in pieces rather than one lump', async () => {
    // The point of streaming at all. Three chunks in, more than one delta out.
    replies(['One. ', 'Two. ', 'Three.', `\n---DETAIL---\n${DETAIL}`]);

    const deltas: string[] = [];
    await streamInsight(request(), (text) => deltas.push(text));

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toContain('One. Two. Three.');
  });

  it('validates citations before the findings are returned', async () => {
    const invented = JSON.stringify({
      findings: [
        {
          title: 'Invented',
          detail: 'Cites a metric nobody measured.',
          severity: 'urgent',
          evidence: ['orders.doesNotExist'],
        },
        {
          title: 'Real',
          detail: 'Cites one that exists.',
          severity: 'urgent',
          evidence: ['orders.actionRequired'],
        },
      ],
      suggestedActions: [],
    });

    replies([`Summary.\n---DETAIL---\n${invented}`]);

    const insight = await streamInsight(request(), () => undefined);

    // The fabricated one is dropped entirely, not corrected and not warned
    // about. The real one survives untouched.
    expect(insight.findings).toHaveLength(1);
    expect(insight.findings[0]?.title).toBe('Real');
  });

  it('takes a suggested action’s link from the metric, never from the reply', async () => {
    const withLink = JSON.stringify({
      findings: [],
      suggestedActions: [
        {
          label: 'Go somewhere',
          detail: 'Anywhere.',
          metricKey: 'orders.actionRequired',
          href: 'https://evil.example/phish',
        },
      ],
    });

    replies([`Summary.\n---DETAIL---\n${withLink}`]);

    const insight = await streamInsight(request(), () => undefined);

    expect(insight.suggestedActions[0]?.href).toBe('/account/orders');
  });

  it('keeps the prose when the detail will not parse, and says why', async () => {
    /*
     * NOT the deterministic fallback: the summary already reached the reader,
     * and replacing it now would rewrite what they watched arrive. The
     * findings are simply empty and `fallbackReason` records it.
     */
    replies(['A perfectly good summary.', '\n---DETAIL---\nnot json at all']);

    const insight = await streamInsight(request(), () => undefined);

    expect(insight.summary).toBe('A perfectly good summary.');
    expect(insight.findings).toEqual([]);
    expect(insight.source).toBe('model');
    expect(insight.fallbackReason).toBe('unusable');
  });

  it('treats a reply with no marker as all prose', async () => {
    replies(['The model forgot the marker entirely.']);

    const insight = await streamInsight(request(), () => undefined);

    expect(insight.summary).toBe('The model forgot the marker entirely.');
    expect(insight.findings).toEqual([]);
  });

  it('falls back honestly when the provider is out of quota', async () => {
    // Exactly what a spent Gemini free tier does, which is how this path gets
    // exercised in development.
    emit.mockRejectedValue(new AssistantBusyError('quota exceeded', true));

    const deltas: string[] = [];
    const insight = await streamInsight(request(), (text) => deltas.push(text));

    expect(insight.source).toBe('deterministic');
    expect(insight.fallbackReason).toBe('unavailable');
    // The reader still gets a summary, and it is the deterministic one.
    expect(deltas.join('')).toBe(insight.summary);
    expect(insight.summary).toContain('attention');
  });

  it('cites only permitted keys however the provider behaves', async () => {
    replies([`Summary.\n---DETAIL---\n${DETAIL}`]);

    const insight = await streamInsight(request(), () => undefined);
    const permitted = new Set(insight.metricKeys);

    for (const finding of insight.findings) {
      for (const key of finding.evidence) expect(permitted.has(key)).toBe(true);
    }
    for (const action of insight.suggestedActions) {
      if (action.metricKey !== null) expect(permitted.has(action.metricKey)).toBe(true);
    }
  });
});
