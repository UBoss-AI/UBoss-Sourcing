/**
 * Whether chat attachments are on, and which stored files may be handed out.
 *
 * Its own module because both the message serialiser and the upload service
 * ask, and the answer must be the same in both places: a card that says
 * "download" for a file the download route then refuses is a broken promise.
 *
 * The rule, in one sentence: a file is accepted only if something will scan
 * it, or the operator has explicitly said unscanned files are acceptable -
 * which production refuses. With neither, attachments say they are
 * unavailable rather than storing a file nobody may ever open.
 */
import { env } from '../../config/env.js';

export type AttachmentUnavailableReason = 'DISABLED' | 'NO_SCANNER';

export function attachmentAvailability():
  | { available: true }
  | { available: false; reason: AttachmentUnavailableReason } {
  if (!env.PREORDER_CHAT_ATTACHMENTS_ENABLED) return { available: false, reason: 'DISABLED' };
  if (env.MALWARE_SCANNER_DRIVER !== 'clamav' && !env.PREORDER_CHAT_ALLOW_UNSCANNED_ATTACHMENTS) {
    return { available: false, reason: 'NO_SCANNER' };
  }
  return { available: true };
}

export function attachmentsServable(scanState: 'CLEAN' | 'SCANNER_UNCONFIGURED'): boolean {
  if (scanState === 'CLEAN') return true;
  return env.PREORDER_CHAT_ALLOW_UNSCANNED_ATTACHMENTS;
}

/** What the composer may offer, stated once for both apps. */
export const ATTACHMENT_TYPES = Object.freeze([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
