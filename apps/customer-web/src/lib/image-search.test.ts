/**
 * The client-side half of image search, and the AI Mode hand-off.
 *
 * Neither is the control. The server sniffs magic bytes and ignores whatever
 * the browser claimed about a file, and every `/assistant` route is behind the
 * session guard. What is tested here is the part that decides whether a
 * customer sees a clear message in the file picker's own moment or waits
 * through a slow upload to be told no — and whether the question they typed on
 * the landing page survives the trip to the sign-in form and back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, rejectImage } from './image-search';
import { setPendingQuestion, takePendingQuestion } from './ai-mode';

function file(options: { type?: string; bytes?: number; name?: string } = {}): File {
  const bytes = options.bytes ?? 1_024;
  return new File([new Uint8Array(bytes)], options.name ?? 'shelf.jpg', {
    type: options.type ?? 'image/jpeg',
  });
}

describe('what may be uploaded', () => {
  it('accepts the four types the server can sniff', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(rejectImage(file({ type })), type).toBeNull();
    }
  });

  it('refuses a type the server would refuse anyway, before the upload', () => {
    // SVG is absent from the accepted list deliberately — it is a
    // script-capable document, not a picture.
    expect(rejectImage(file({ type: 'image/svg+xml' }))).toMatchObject({ reason: 'type' });
    expect(rejectImage(file({ type: 'application/pdf' }))).toMatchObject({ reason: 'type' });
  });

  it('lets an unknown type through for the server to judge', () => {
    // A camera capture on some Android builds arrives with an empty `type`.
    // Refusing it here would break the one flow this feature exists for.
    expect(rejectImage(file({ type: '' }))).toBeNull();
  });

  it('refuses an oversized file, and says what the ceiling is', () => {
    const rejection = rejectImage(file({ bytes: MAX_IMAGE_BYTES + 1 }));

    expect(rejection).toMatchObject({ reason: 'size', maxMb: 5 });
  });

  it('refuses an empty file', () => {
    expect(rejectImage(file({ bytes: 0 }))).toMatchObject({ reason: 'empty' });
  });
});

describe('carrying a question into AI Mode', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('parks a question and hands it over exactly once', () => {
    setPendingQuestion('Which suction catheters fit a 10 Fr port?');

    expect(takePendingQuestion()).toEqual({
      text: 'Which suction catheters fit a 10 Fr port?',
      intent: 'send',
    });

    // Read once. A refresh of the AI page must not re-ask what was asked, and
    // this is a hand-off rather than a stored draft.
    expect(takePendingQuestion()).toBeNull();
  });

  it('parks nothing for an empty box, and clears anything already parked', () => {
    setPendingQuestion('something');
    setPendingQuestion('   ');

    expect(takePendingQuestion()).toBeNull();
  });

  it('ignores a value somebody hand-edited rather than acting on it', () => {
    sessionStorage.setItem('uboss_ai_pending_question', '{"text":"hi","intent":"explode"}');

    expect(takePendingQuestion()).toBeNull();
    // Cleared as it was read, so a bad value cannot be retried on every mount.
    expect(sessionStorage.getItem('uboss_ai_pending_question')).toBeNull();
  });
});
