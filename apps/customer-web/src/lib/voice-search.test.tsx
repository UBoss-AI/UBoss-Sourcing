/**
 * Dictating a search term.
 *
 * There is no speech engine in jsdom, so one is stubbed on `window` — which is
 * exactly the seam the hook reads, including the vendor-prefixed name Safari
 * still uses. What is under test is the behaviour around the engine, and it is
 * the behaviour that would go wrong quietly:
 *
 *   - a browser with no engine offers no microphone at all, rather than a
 *     button that reports a failure after it is pressed;
 *   - a finalised phrase reaches the caller and an interim guess does not,
 *     because only the finalised one belongs in the search box;
 *   - nothing is ever submitted — speech recognition is confident and often
 *     wrong, and a search that runs itself on a misheard word is a page of
 *     results nobody asked for;
 *   - a refused microphone says so, and pressing stop does not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVoiceSearch } from './voice-search';

/** The slice of `SpeechRecognition` the hook actually touches. */
class FakeRecognition {
  static last: FakeRecognition | null = null;

  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;

  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  started = false;
  aborted = false;

  constructor() {
    FakeRecognition.last = this;
  }

  start(): void {
    this.started = true;
    this.onstart?.();
  }

  stop(): void {
    this.onend?.();
  }

  abort(): void {
    this.aborted = true;
    this.onend?.();
  }

  /** Deliver one result frame, the shape the spec defines. */
  emit(transcript: string, isFinal: boolean): void {
    this.onresult?.({
      resultIndex: 0,
      results: { length: 1, 0: { length: 1, isFinal, 0: { transcript } } },
    });
  }
}

function installEngine(): void {
  vi.stubGlobal('SpeechRecognition', FakeRecognition);
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRecognition.last = null;
});

describe('voice search', () => {
  it('reports no support where the browser has no engine', () => {
    // Firefox, to date. The caller renders no microphone rather than a button
    // that can only fail.
    const { result } = renderHook(() =>
      useVoiceSearch({ language: 'en-GB', onTranscript: vi.fn() }),
    );

    expect(result.current.isSupported).toBe(false);
  });

  it('listens in the interface language, one phrase at a time', () => {
    installEngine();
    const { result } = renderHook(() =>
      useVoiceSearch({ language: 'pl-PL', onTranscript: vi.fn() }),
    );

    act(() => {
      result.current.start();
    });

    // Wrong language here and the engine mishears everything a Polish reader
    // says into an English recogniser.
    expect(FakeRecognition.last?.lang).toBe('pl-PL');
    // Not a dictation session: `continuous` would leave the microphone open
    // listening to the room until something else closed it.
    expect(FakeRecognition.last?.continuous).toBe(false);
    expect(result.current.status).toBe('listening');
  });

  it('hands over a finalised phrase and only shows an interim one', () => {
    installEngine();
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceSearch({ language: 'en-GB', onTranscript }));

    act(() => {
      result.current.start();
    });

    act(() => {
      FakeRecognition.last?.emit('suction cath', false);
    });

    // Shown under the box, never written into it: an interim guess is still
    // being revised.
    expect(result.current.interim).toBe('suction cath');
    expect(onTranscript).not.toHaveBeenCalled();

    act(() => {
      FakeRecognition.last?.emit('suction catheter', true);
    });

    expect(onTranscript).toHaveBeenCalledWith('suction catheter');
  });

  it('says plainly when the microphone was refused', () => {
    installEngine();
    const { result } = renderHook(() =>
      useVoiceSearch({ language: 'en-GB', onTranscript: vi.fn() }),
    );

    act(() => {
      result.current.start();
    });
    act(() => {
      FakeRecognition.last?.onerror?.({ error: 'not-allowed' });
    });

    expect(result.current.errorKey).toBe('voice.error.permissionDenied');
  });

  it('treats a deliberate stop as a stop, not as a failure', () => {
    installEngine();
    const { result } = renderHook(() =>
      useVoiceSearch({ language: 'en-GB', onTranscript: vi.fn() }),
    );

    act(() => {
      result.current.start();
    });
    act(() => {
      // What the browser reports when the page called stop() — which is the
      // customer pressing the button again. Reporting "something went wrong"
      // for that is the standard false alarm in every wrapper around this API.
      FakeRecognition.last?.onerror?.({ error: 'aborted' });
      result.current.stop();
    });

    expect(result.current.errorKey).toBeNull();
    expect(result.current.status).toBe('idle');
  });

  it('releases the microphone when the page goes', () => {
    installEngine();
    const { result, unmount } = renderHook(() =>
      useVoiceSearch({ language: 'en-GB', onTranscript: vi.fn() }),
    );

    act(() => {
      result.current.start();
    });
    const recognition = FakeRecognition.last;

    unmount();

    // Otherwise the recording indicator stays lit in the tab after the page
    // that opened it has gone.
    expect(recognition?.aborted).toBe(true);
  });
});
