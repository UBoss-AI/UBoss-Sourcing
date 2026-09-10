/**
 * Dictating a search term instead of typing it.
 *
 * Built on the browser's own `SpeechRecognition`, and that choice is the whole
 * design. The alternative — recording audio and posting it to a transcription
 * service — would mean this deployment shipping a microphone recording of
 * whoever is standing near the machine to a third party, paying per second for
 * it, and adding that vendor to the privacy notice. For "cannula 18 gauge"
 * spoken into a search box, the engine already in the browser is the right
 * tool. Nothing leaves the page through this module.
 *
 * Three things worth knowing before changing anything here:
 *
 *   - **It never submits.** The transcript lands in the search box and stops
 *     there. Speech recognition is confident and frequently wrong; a search
 *     that runs itself on a misheard word is a page of results for something
 *     nobody asked for. The customer reads what was heard and presses Search.
 *   - **Support is genuinely partial.** Chrome, Edge and Safari have it; every
 *     Firefox release to date does not. `isSupported` is false there, and the
 *     caller renders no microphone at all rather than a button that reports a
 *     failure after it is pressed.
 *   - **The permission prompt is the browser's.** Starting recognition is what
 *     raises it. There is no useful way to ask first: `navigator.permissions`
 *     does not carry `microphone` everywhere, and a pre-flight
 *     `getUserMedia` would open a second, separate stream purely to be
 *     closed again.
 *
 * The failure modes are reported as translation keys rather than as sentences,
 * because this module has no `t` and the storefront speaks eight languages.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranslationKey } from '@/i18n/i18n-context';

// ---------------------------------------------------------------------------
// The Web Speech API, typed
//
// `lib.dom.d.ts` does not ship these, and the vendor-prefixed constructor is
// still the only one Safari exposes. Declared here rather than in a global
// `.d.ts` so the surface stays next to the only code that uses it, and so
// nothing else in the app can reach for `window.webkitSpeechRecognition`
// without going through this hook.
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;

  const candidate = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
}

/** True where the browser can do this at all. Read once, at module load. */
export function isVoiceSearchSupported(): boolean {
  return recognitionConstructor() !== null;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export type VoiceSearchStatus =
  /** Nothing has been started, or the last attempt finished cleanly. */
  | 'idle'
  /** `start()` has been called; the browser may be showing its prompt. */
  | 'starting'
  /** The microphone is open and audio is being transcribed. */
  | 'listening';

export interface VoiceSearch {
  /** False on a browser with no speech engine. The caller renders no button. */
  isSupported: boolean;
  status: VoiceSearchStatus;
  /** Set on a failure, cleared on the next `start()`. A key, not a sentence. */
  errorKey: TranslationKey | null;
  /**
   * What has been heard so far, including the interim guess the engine is
   * still revising. Shown live under the search box; the caller writes the
   * final result into the input itself.
   */
  interim: string;
  start: () => void;
  stop: () => void;
}

/**
 * Map the spec's error strings onto something a customer can act on.
 *
 * `aborted` is deliberately absent: it is what the browser reports when the
 * page called `stop()` or `abort()`, which is the customer pressing the button
 * again. Reporting "something went wrong" for a deliberate stop is the classic
 * false alarm in every wrapper around this API.
 */
function errorKeyFor(error: string): TranslationKey | null {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'voice.error.permissionDenied';
    case 'no-speech':
      return 'voice.error.noSpeech';
    case 'audio-capture':
      return 'voice.error.noMicrophone';
    case 'network':
      return 'voice.error.network';
    case 'aborted':
      return null;
    default:
      return 'voice.error.failed';
  }
}

export function useVoiceSearch(options: {
  /** BCP-47, from the interface language. Wrong here and it mishears everything. */
  language: string;
  /** Called once per finalised phrase, with the text to put in the box. */
  onTranscript: (text: string) => void;
}): VoiceSearch {
  const { language, onTranscript } = options;

  // Read once. A browser does not grow a speech engine mid-visit, and calling
  // this on every render would re-read two window properties for nothing.
  const [isSupported] = useState(isVoiceSearchSupported);

  const [status, setStatus] = useState<VoiceSearchStatus>('idle');
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [interim, setInterim] = useState('');

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  /*
   * The callback is held in a ref rather than closed over.
   *
   * `onTranscript` is almost always an inline arrow from the caller, so it is a
   * new function on every render. Putting it in the dependency list of the
   * effect that wires up `onresult` would tear down and rebuild the recogniser
   * on every keystroke in the search box — which, mid-dictation, ends the
   * dictation.
   */
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  // Stop cleanly if the customer navigates away mid-sentence. Without this the
  // microphone indicator stays lit in the tab after the page has gone.
  useEffect(
    () => () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    },
    [],
  );

  const stop = useCallback(() => {
    // `stop`, not `abort`: it lets the engine finalise what it has already
    // heard, so releasing the button does not throw away the last word.
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Recognition = recognitionConstructor();
    if (Recognition === null) return;

    // Already running. Pressing the button again is "stop", which is what the
    // caller's toggle does — this is the guard for a double event.
    if (recognitionRef.current !== null) return;

    setErrorKey(null);
    setInterim('');
    setStatus('starting');

    const recognition = new Recognition();
    recognition.lang = language;
    // One phrase, not a dictation session. The customer is saying a product
    // name, and `continuous` would leave the microphone open listening to the
    // room until something else closed it.
    recognition.continuous = false;
    // Interim results are what make the button feel alive. They are shown, and
    // never written into the search box — only a finalised phrase is.
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setStatus('listening');
    };

    recognition.onresult = (event) => {
      let live = '';

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript ?? '';

        if (result?.isFinal === true) {
          const finalised = text.trim();
          if (finalised.length > 0) onTranscriptRef.current(finalised);
        } else {
          live += text;
        }
      }

      setInterim(live);
    };

    recognition.onerror = (event) => {
      setErrorKey(errorKeyFor(event.error));
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setStatus('idle');
      setInterim('');
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch {
      // `InvalidStateError` from a recogniser the browser considers already
      // started. Nothing is listening, so the state has to be put back.
      recognitionRef.current = null;
      setStatus('idle');
      setErrorKey('voice.error.failed');
    }
  }, [language]);

  return { isSupported, status, errorKey, interim, start, stop };
}
