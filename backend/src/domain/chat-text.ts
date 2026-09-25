/**
 * What a chat message may contain, and how it is measured.
 *
 * A message is stored as the person wrote it and rendered as PLAIN TEXT on
 * every screen - never as HTML, never through a Markdown renderer. That one
 * decision is the XSS defence: `<script>` in a message is shown as the eight
 * characters somebody typed, because nothing ever asks a browser to parse it.
 * So nothing here escapes or strips markup; escaping at write time would
 * corrupt what was said and protect nothing a correct renderer does not
 * already.
 *
 * What IS removed is what nobody types on purpose and what exists to deceive:
 *
 *   - C0 and C1 control characters other than tab and newline. A NUL in a
 *     TEXT column, a bell, an escape sequence for somebody's terminal log.
 *   - Unicode bidirectional overrides and isolates (U+202A-U+202E,
 *     U+2066-U+2069). "invoice‮fdp.exe" displays as "invoiceexe.pdf";
 *     in a conversation about documents and payments that trick is the
 *     point of the character.
 *
 * Length is counted in code points, not UTF-16 units, so an emoji is one
 * character to the customer and to this limit alike.
 */
import { ErrorCode, badRequest } from './errors.js';

/**
 * Controls except \t (09) and \n (0A); \r is normalised away below.
 * Written with escapes so no raw control character sits in this source file.
 */
// eslint-disable-next-line no-control-regex
const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/** Count what a person would call characters. */
export function characterCount(text: string): number {
  return [...text].length;
}

/** Remove the characters above and normalise line endings. Does not trim. */
export function cleanChatText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(DISALLOWED_CONTROLS, '')
    .replace(BIDI_CONTROLS, '');
}

/**
 * The body of a message as it will be stored, or a 400.
 *
 * Leading and trailing whitespace is trimmed - a message of three blank lines
 * and a word is the word - and a message that is empty after that is refused.
 */
export function normaliseChatBody(raw: string, maxChars: number, field = 'body'): string {
  const body = cleanChatText(raw).trim();

  if (body.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Write a message before sending it.', [
      { field, code: 'EMPTY' },
    ]);
  }

  if (characterCount(body) > maxChars) {
    throw badRequest(
      ErrorCode.PREORDER_CHAT_MESSAGE_TOO_LONG,
      `Messages can be up to ${String(maxChars)} characters.`,
      [{ field, code: 'TOO_LONG', meta: { maxChars } }],
    );
  }

  return body;
}

/**
 * One line for the inbox row: whitespace collapsed, cut on a character (not a
 * UTF-16 unit, which could split an emoji into a broken half) with an ellipsis.
 */
export function previewOf(body: string, maxChars = 160): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const characters = [...flat];
  return characters.length <= maxChars ? flat : `${characters.slice(0, maxChars - 1).join('')}…`;
}

/**
 * A file name that is safe to SHOW.
 *
 * Never used to build a path - storage keys are generated - but it is shown in
 * two browsers and a download header, so control characters, bidi overrides
 * and path separators go, and so does anything that would make it look like a
 * different file. What remains is capped at a length a header will carry.
 */
export function safeFileName(raw: string, fallback = 'attachment'): string {
  const cleaned = cleanChatText(raw)
    .replace(/[\\/:*?"<>|\n\t]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const characters = [...cleaned];
  const bounded = characters.length > 120 ? characters.slice(0, 120).join('') : cleaned;
  return bounded.length === 0 ? fallback : bounded;
}
