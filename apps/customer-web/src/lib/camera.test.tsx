/**
 * The device camera.
 *
 * What matters here is not that a preview appears — a test cannot see one —
 * but the four things that go wrong with a camera in a web page, all of which
 * are invisible until somebody complains:
 *
 *   1. **The device is released.** Every exit path has to stop every track:
 *      cancel, capture, unmount. A `MediaStreamTrack` left live keeps the
 *      indicator light on for the rest of the visit and holds the camera away
 *      from every other application on the machine. This is the one a
 *      refactor breaks and nobody notices in development, because a webcam
 *      light is behind the screen you are looking at.
 *   2. **A refusal is a state.** Declining the prompt has to land somewhere
 *      the dialog can render as an answer, separately from a machine that has
 *      no camera and from one where the camera failed — three causes, three
 *      sentences, because the customer's next move differs.
 *   3. **Nothing starts on its own.** `start` is the only thing that opens a
 *      stream, and it is called from a press.
 *   4. **The frame is a JPEG.** Not a PNG: a photograph of a real scene as a
 *      1920x1080 PNG is several megabytes and fails the 5 MB limit the server
 *      enforces, for no gain.
 *
 * jsdom has no `mediaDevices`, no `videoWidth` on a `<video>` and no
 * `toBlob` on a canvas, so all three are stubbed. That is the cost of testing
 * anything media-related in jsdom, and the alternative — testing none of it —
 * leaves the release-the-device rule unguarded.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCamera } from './camera';

/**
 * A stand-in for one camera track, with its `stop` handed back separately.
 *
 * Separately, because `expect(track.stop)` is an unbound method reference and
 * the lint rule is right about it: the spy is what the test cares about, so
 * the spy is what it holds.
 */
function makeTrack(): { track: MediaStreamTrack; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn();
  return { track: { stop, kind: 'video' } as unknown as MediaStreamTrack, stop };
}

function makeStream(tracks: MediaStreamTrack[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

/** Install a `mediaDevices` that resolves, or rejects with a named error. */
function stubMediaDevices(behaviour: { stream?: MediaStream; rejectWith?: string }): {
  getUserMedia: ReturnType<typeof vi.fn>;
} {
  const getUserMedia = vi.fn(() => {
    if (behaviour.rejectWith !== undefined) {
      const error = new Error(behaviour.rejectWith);
      error.name = behaviour.rejectWith;
      return Promise.reject(error);
    }
    return Promise.resolve(behaviour.stream);
  });

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });

  return { getUserMedia };
}

/** Take `mediaDevices` away, which is what an insecure context looks like. */
function removeMediaDevices(): void {
  // `delete` rather than setting it undefined: the hook checks with `in`,
  // because that is the shape of the real absence.
  const record = navigator as unknown as Record<string, unknown>;
  delete record.mediaDevices;
}

/**
 * A `<video>` the hook can attach a stream to.
 *
 * `videoWidth` and `videoHeight` are read-only and always 0 in jsdom, so the
 * frame size a capture would use has to be defined here.
 */
function makeVideo(width = 1280, height = 960): HTMLVideoElement {
  const video = document.createElement('video');
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: width });
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: height });
  return video;
}

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

beforeEach(() => {
  // jsdom implements neither, and a capture needs both.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    drawImage: vi.fn(),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.toBlob = function toBlob(
    callback: BlobCallback,
    type?: string,
  ): void {
    callback(new Blob(['jpeg-bytes'], { type: type ?? 'image/png' }));
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalMediaDevices === undefined) removeMediaDevices();
  else Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
});

describe('the device camera', () => {
  it('starts nothing until it is asked to', () => {
    const { getUserMedia } = stubMediaDevices({ stream: makeStream([makeTrack().track]) });

    const { result } = renderHook(() => useCamera());

    // Mounting the hook must not open a camera. A page that turns one on
    // because a dialog opened is a page that turns one on without being asked.
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('goes live and hands the stream to the video element', async () => {
    const stream = makeStream([makeTrack().track]);
    stubMediaDevices({ stream });

    const { result } = renderHook(() => useCamera());
    const video = makeVideo();
    result.current.videoRef.current = video;

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.status).toBe('live');
    expect(video.srcObject).toBe(stream);
  });

  it('asks for the rear camera, because the subject is on a shelf', async () => {
    const { getUserMedia } = stubMediaDevices({ stream: makeStream([makeTrack().track]) });

    const { result } = renderHook(() => useCamera());
    result.current.videoRef.current = makeVideo();

    await act(async () => {
      await result.current.start();
    });

    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({ facingMode: 'environment' }),
        // No microphone. Asking for one would widen the permission prompt to
        // something this feature has no use for.
        audio: false,
      }),
    );
  });

  it('calls a declined prompt what it is', async () => {
    stubMediaDevices({ rejectWith: 'NotAllowedError' });

    const { result } = renderHook(() => useCamera());
    result.current.videoRef.current = makeVideo();

    await act(async () => {
      await result.current.start();
    });

    // Separately from a failure: a refusal is the customer's to reverse.
    expect(result.current.status).toBe('denied');
  });

  it('separates a broken camera from a refused one', async () => {
    stubMediaDevices({ rejectWith: 'NotReadableError' });

    const { result } = renderHook(() => useCamera());
    result.current.videoRef.current = makeVideo();

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.status).toBe('failed');
  });

  it('says so where there is no camera API at all', async () => {
    // An insecure context has no `mediaDevices` property whatsoever, which is
    // why the hook tests with `in` rather than for a falsy value.
    removeMediaDevices();

    const { result } = renderHook(() => useCamera());
    expect(result.current.isSupported).toBe(false);

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.status).toBe('unavailable');
  });

  it('releases the device on cancel', async () => {
    const { track, stop } = makeTrack();
    stubMediaDevices({ stream: makeStream([track]) });

    const { result } = renderHook(() => useCamera());
    const video = makeVideo();
    result.current.videoRef.current = video;

    await act(async () => {
      await result.current.start();
    });

    act(() => {
      result.current.stop();
    });

    expect(stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    expect(result.current.status).toBe('idle');
  });

  it('releases the device when the component goes away', async () => {
    const { track, stop } = makeTrack();
    stubMediaDevices({ stream: makeStream([track]) });

    const { result, unmount } = renderHook(() => useCamera());
    result.current.videoRef.current = makeVideo();

    await act(async () => {
      await result.current.start();
    });

    unmount();

    // The one that matters most, and the one a refactor breaks silently: a
    // dialog closed with the camera live leaves the light on for the visit.
    expect(stop).toHaveBeenCalled();
  });

  it('stops an orphaned stream when the dialog closed during the prompt', async () => {
    const { track, stop } = makeTrack();
    stubMediaDevices({ stream: makeStream([track]) });

    const { result } = renderHook(() => useCamera());
    // No video element: the dialog went away while the permission prompt was
    // still up, so the stream that arrives afterwards has nowhere to go.
    result.current.videoRef.current = null;

    await act(async () => {
      await result.current.start();
    });

    expect(stop).toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('takes the frame as a JPEG, named and dated', async () => {
    stubMediaDevices({ stream: makeStream([makeTrack().track]) });

    const { result } = renderHook(() => useCamera());
    result.current.videoRef.current = makeVideo(1600, 1200);

    await act(async () => {
      await result.current.start();
    });

    const taken: { file: File | null } = { file: null };
    await act(async () => {
      taken.file = await result.current.capture();
    });

    expect(taken.file).not.toBeNull();
    expect(taken.file?.type).toBe('image/jpeg');
    expect(taken.file?.name).toMatch(/^photo-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.jpg$/);
  });

  it('takes nothing when there is no frame yet', async () => {
    stubMediaDevices({ stream: makeStream([makeTrack().track]) });

    const { result } = renderHook(() => useCamera());
    // A video with no dimensions is one whose first frame has not arrived.
    // Capturing it would draw a 0x0 canvas and upload an empty file.
    result.current.videoRef.current = makeVideo(0, 0);

    await act(async () => {
      await result.current.start();
    });

    const taken: { file: File | null } = { file: null };
    await act(async () => {
      taken.file = await result.current.capture();
    });

    expect(taken.file).toBeNull();
  });
});
