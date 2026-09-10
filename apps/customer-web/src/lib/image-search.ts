/**
 * Searching the catalogue with a photograph.
 *
 * The client half is deliberately thin: pick or capture a file, check it is
 * something the server will accept, post it, and hand back products in exactly
 * the shape the catalogue grid already renders. Everything that decides *what*
 * matches happens on the server — see `image-search.service.ts` — because it is
 * a call to the deployment's AI provider and the key for that lives nowhere
 * near a browser.
 *
 * The checks below duplicate the server's, on purpose. They are not the
 * control: the server sniffs magic bytes and ignores whatever the browser
 * claimed, so a renamed `.exe` is refused there whatever happens here. They
 * exist so that choosing a 40 MB video fails in the file picker's own moment
 * rather than after a slow upload, which is the difference between a validation
 * message and a customer thinking the site is broken.
 */
import { postFile } from './api';
import type { Product } from './types';
import type { TranslationKey } from '@/i18n/i18n-context';

/**
 * What the server's magic-byte sniffer recognises. SVG is absent from that
 * list deliberately — it is a script-capable document, not a picture — so it is
 * absent here too, and the file picker never offers it.
 */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** The `accept` attribute for the picker. Mirrors the list above. */
export const IMAGE_ACCEPT_ATTRIBUTE = ACCEPTED_IMAGE_TYPES.join(',');

/**
 * 5 MB, matching `UPLOAD_MAX_BYTES`'s default on the API.
 *
 * A deployment that raises the server's limit does not have to change this: the
 * only consequence is that this side refuses a file the server would have taken,
 * which fails safe. A deployment that *lowers* it gets the server's message
 * instead, which is also correct.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** A rejection, as a key the caller renders in the page's own language. */
export type ImageRejection =
  | { reason: 'type'; key: TranslationKey }
  | { reason: 'size'; key: TranslationKey; maxMb: number }
  | { reason: 'empty'; key: TranslationKey };

/** Null when the file is fine to send. */
export function rejectImage(file: File): ImageRejection | null {
  if (file.size === 0) return { reason: 'empty', key: 'imageSearch.error.empty' };

  if (file.size > MAX_IMAGE_BYTES) {
    return {
      reason: 'size',
      key: 'imageSearch.error.tooLarge',
      maxMb: Math.round(MAX_IMAGE_BYTES / 1_048_576),
    };
  }

  /*
   * A camera capture on some Android builds arrives with an empty `type`.
   * Refusing it here would break the one flow this feature exists for, and the
   * server sniffs the bytes regardless — so an unknown type is passed through
   * and only a type we positively know to be wrong is stopped.
   */
  if (file.type !== '' && !ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return { reason: 'type', key: 'imageSearch.error.unsupportedType' };
  }

  return null;
}

export interface ImageSearchResult {
  /**
   * What the model understood the photograph to be, in one sentence.
   *
   * Shown above the results, and not decoration. The match is on what the item
   * is recognised as, so a misreading has to look like a misreading rather
   * than like a catalogue full of the wrong stock.
   */
  description: string;
  /** Words a shopper would have typed. Used for the "refine in the catalogue" link. */
  terms: string[];
  products: Product[];
  currency: string;
  country: string | null;
}

export async function searchByImage(
  file: File,
  options: {
    currency: string;
    country: string | null;
    language: string;
    signal?: AbortSignal;
  },
): Promise<ImageSearchResult> {
  const form = new FormData();
  // The field name the route reads. The filename travels with it and is
  // ignored by the server, which generates nothing from it and stores nothing.
  form.append('image', file);

  return await postFile<ImageSearchResult>('/catalog/image-search', form, {
    query: {
      currency: options.currency,
      country: options.country ?? undefined,
      language: options.language,
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
