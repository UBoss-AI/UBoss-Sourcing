/**
 * The device camera, as a still photograph.
 *
 * Image search has always had a "take a photo" button, and on a phone it works
 * properly: `<input type="file" capture="environment">` hands the whole job to
 * the platform's own camera app, which has autofocus, a flash and the full
 * sensor resolution. On a laptop the same attribute is **ignored** — the spec
 * says a browser may treat it as a hint — so the button opened a file picker,
 * and somebody sitting in front of a webcam with the product in their hand had
 * no way to photograph it.
 *
 * This is the other half: `getUserMedia`, a live preview and a shutter, for
 * every device that has a camera the browser will lend us. The capture goes
 * through exactly the same path as a chosen file — the same size and type
 * checks, the same upload, the same analysis on the server — because a
 * photograph is a photograph however it arrived, and a second pipeline would
 * be a second set of limits to keep in step.
 *
 * ---
 *
 * **Nothing starts until somebody presses the button.** `start` is called from
 * a click and never from an effect. A page that turns a camera on because you
 * opened a dialog is a page that turns a camera on without being asked, and
 * the light on the bezel is the customer finding out.
 *
 * **Every track is stopped on the way out**, on unmount, on cancel, and
 * immediately after a capture. A `MediaStreamTrack` left live holds the device
 * open and the indicator light on for the rest of the visit, which reads as
 * being watched — and on a laptop it also stops any other application getting
 * the camera.
 *
 * **A refusal is a state, not an error.** Somebody who declines the permission
 * prompt has answered the question, and the answer is respected: the dialog
 * says the camera was not allowed and points at the file picker, which needs
 * no permission at all. The same goes for a machine with no camera, and for a
 * deployment served over plain HTTP, where `getUserMedia` does not exist
 * because the context is not secure.
 *
 * **The frame is a JPEG and it never leaves the tab except as the upload.**
 * There is no object URL kept beyond the preview, nothing written to storage,
 * and no copy retained after the search — the dialog owns the file for as long
 * as the search takes, which is the same promise its own docblock makes about
 * a chosen one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** What the camera is doing. One value, so two of these cannot both be true. */
export type CameraStatus =
  | 'idle'
  | 'starting'
  | 'live'
  /** The permission prompt was declined, or the browser is blocking it. */
  | 'denied'
  /** No camera, or no `getUserMedia` — an insecure context has neither. */
  | 'unavailable'
  | 'failed';

export interface Camera {
  status: CameraStatus;
  /** False where there is no point offering the button at all. */
  isSupported: boolean;
  /** Attach to a `<video autoPlay playsInline muted>`. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  start: () => Promise<void>;
  stop: () => void;
  /** The current frame as a JPEG, or null if there is nothing to take. */
  capture: () => Promise<File | null>;
}

/**
 * `image/jpeg` at 0.9, and the video's own pixel dimensions.
 *
 * JPEG rather than PNG because this is a photograph: a 1920x1080 PNG of a real
 * scene is several megabytes and would fail the 5 MB check the server enforces,
 * for no gain — the model reads the same picture either way. 0.9 is high enough
 * that printed markings on a product stay legible, which is the whole reason
 * somebody is photographing it.
 */
const CAPTURE_TYPE = 'image/jpeg';
const CAPTURE_QUALITY = 0.9;

function isSupportedHere(): boolean {
  /*
   * `in`, not a truthiness or `typeof` check.
   *
   * The DOM types declare `navigator.mediaDevices` as always present, so an
   * optional chain on it is "unnecessary" as far as the compiler and the lint
   * rule are concerned. At runtime it is absent outside a secure context —
   * plain HTTP has no `mediaDevices` at all — which is precisely the case
   * this function exists to detect. An `in` check states that honestly
   * without asking the type system to agree that a non-nullable value might
   * be missing.
   */
  return 'mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices;
}

export function useCamera(): Camera {
  const [status, setStatus] = useState<CameraStatus>('idle');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;

    if (stream !== null) {
      for (const track of stream.getTracks()) track.stop();
    }

    const video = videoRef.current;
    if (video !== null) video.srcObject = null;

    setStatus('idle');
  }, []);

  const start = useCallback(async () => {
    if (!isSupportedHere()) {
      setStatus('unavailable');
      return;
    }

    setStatus('starting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // The rear camera where there is a choice: somebody photographing a
        // box on a shelf is not pointing a selfie camera at it. `facingMode`
        // is a preference rather than a constraint, so a laptop with one
        // front camera still gets that one.
        video: { facingMode: 'environment', width: { ideal: 1920 } },
        audio: false,
      });

      // The dialog may have been closed while the permission prompt was up.
      // Without this the stream is orphaned and the light stays on.
      if (videoRef.current === null) {
        for (const track of stream.getTracks()) track.stop();
        setStatus('idle');
        return;
      }

      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      setStatus('live');
    } catch (error) {
      /*
       * `NotAllowedError` is the refusal, and it is the common one. Everything
       * else — no device, the camera held by another application, a hardware
       * fault — is reported as a failure, because the customer's next move is
       * different: a refusal is theirs to reverse, and a failure is not.
       */
      const name = error instanceof Error ? error.name : '';
      setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed');
    }
  }, []);

  const capture = useCallback(async (): Promise<File | null> => {
    const video = videoRef.current;
    if (video === null || video.videoWidth === 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext('2d');
    if (context === null) return null;

    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, CAPTURE_TYPE, CAPTURE_QUALITY);
    });

    if (blob === null) return null;

    // A name, because the rest of the flow shows one and a file with no name
    // renders as a blank line above the size. Dated rather than random, so a
    // customer who saves it can tell two captures apart.
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
    return new File([blob], `photo-${stamp}.jpg`, { type: CAPTURE_TYPE });
  }, []);

  // The camera does not outlive the component that opened it, however it went
  // away — a route change, a dialog closing, a hot reload in development.
  useEffect(() => stop, [stop]);

  return { status, isSupported: isSupportedHere(), videoRef, start, stop, capture };
}
