/**
 * Has this visitor asked for, or does their connection call for, a lighter page?
 *
 * The storefront's heaviest optional downloads are the two three.js earths —
 * the hero stage and the header mark. Both already have a finished page
 * without them (the CSS sphere and the letter plate), so on a connection that
 * cannot afford them the right answer is simply not to ask for them. The
 * search bar and the product grid never depend on either, so what somebody
 * came to do arrives first whatever this says.
 *
 * Two signals, both from the Network Information API:
 *
 *   - `saveData` — the visitor turned on their browser's or phone's data
 *     saver. That is an explicit request, and it is honoured on any connection.
 *   - `effectiveType` of `slow-2g`, `2g` or `3g` — the browser's own estimate
 *     from measured round trips and throughput, not the radio's name. A 3G
 *     estimate is roughly 700 kbit/s, at which a multi-megabyte scene costs
 *     tens of seconds of somebody's data for a backdrop.
 *
 * The API is Chromium-only. Its absence (Firefox, Safari) is not evidence of
 * a slow connection, so it only ever rules the heavy media OUT, never in —
 * the same rule `deviceMemory` follows in `HeroStage`.
 */
interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

const SLOW_TYPES = new Set(['slow-2g', '2g', '3g']);

export function prefersLightMedia(): boolean {
  if (typeof navigator === 'undefined') return false;

  const connection = (navigator as Navigator & { connection?: NetworkInformationLike })
    .connection;
  if (connection === undefined) return false;

  if (connection.saveData === true) return true;
  return typeof connection.effectiveType === 'string' && SLOW_TYPES.has(connection.effectiveType);
}
