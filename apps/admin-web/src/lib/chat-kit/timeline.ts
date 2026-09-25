/**
 * A conversation's messages, laid out as a reader scans them.
 *
 * SHARED FILE - see the note in `chat-scroll.ts`.
 *
 * Pure functions, no React: which messages share a bubble group, where a new
 * day begins, where "unread" starts, and which parts of a message are links.
 */

export type TimelineEntry<Item> =
  | { kind: 'day'; key: string; day: string; at: string }
  | { kind: 'unread'; key: string }
  | { kind: 'item'; key: string; item: Item; groupStart: boolean; groupEnd: boolean };

export interface TimelineRules<Item> {
  keyOf: (item: Item) => string;
  /** ISO timestamp. */
  timeOf: (item: Item) => string;
  /**
   * Who wrote it, for grouping. Null for anything that never groups: a system
   * event, a proposal card.
   */
  authorOf: (item: Item) => string | null;
  /** Key of the first unread item, or null. */
  firstUnreadKey: string | null;
  /** The viewer's time zone, so "a new day" is the reader's day. Tests pin it. */
  timeZone?: string | undefined;
}

/** Two messages from one author this close together share a group. */
export const GROUP_WINDOW_MS = 5 * 60_000;

/** `YYYY-MM-DD` of an instant in a time zone. */
export function dayOf(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function buildTimeline<Item>(items: readonly Item[], rules: TimelineRules<Item>): TimelineEntry<Item>[] {
  const entries: TimelineEntry<Item>[] = [];
  let lastDay: string | null = null;
  let previous: Item | null = null;

  items.forEach((item) => {
    const at = rules.timeOf(item);
    const day = dayOf(at, rules.timeZone);
    const key = rules.keyOf(item);
    let brokeGroup = false;

    if (day !== lastDay) {
      entries.push({ kind: 'day', key: `day-${day}`, day, at });
      lastDay = day;
      brokeGroup = true;
    }
    if (key === rules.firstUnreadKey) {
      entries.push({ kind: 'unread', key: 'unread' });
      brokeGroup = true;
    }

    const author = rules.authorOf(item);
    const joinsPrevious =
      !brokeGroup &&
      previous !== null &&
      author !== null &&
      rules.authorOf(previous) === author &&
      new Date(at).getTime() - new Date(rules.timeOf(previous)).getTime() < GROUP_WINDOW_MS;

    if (joinsPrevious) {
      const last = entries.at(-1);
      if (last?.kind === 'item') last.groupEnd = false;
    }
    entries.push({ kind: 'item', key, item, groupStart: !joinsPrevious, groupEnd: true });
    previous = item;
  });

  return entries;
}

/**
 * The first unread message, from the server's unread COUNT.
 *
 * The server says how many of the other side's messages this viewer has not
 * read; they are the newest ones, so the first unread is that many back from
 * the end among the other side's messages. More unread than are loaded means
 * the oldest loaded one of theirs.
 */
export function firstUnreadKey<Item>(
  items: readonly Item[],
  unreadCount: number,
  isFromOtherSide: (item: Item) => boolean,
  keyOf: (item: Item) => string,
): string | null {
  if (unreadCount <= 0) return null;
  const theirs = items.filter(isFromOtherSide);
  if (theirs.length === 0) return null;
  const first = theirs[Math.max(0, theirs.length - unreadCount)];
  return first === undefined ? null : keyOf(first);
}

/** "Today", "Yesterday", or the date in the reader's language. */
export function dayLabel(
  day: string,
  locale: string,
  words: { today: string; yesterday: string },
  now: Date = new Date(),
  timeZone?: string,
): string {
  const today = dayOf(now.toISOString(), timeZone);
  const yesterday = dayOf(new Date(now.getTime() - 86_400_000).toISOString(), timeZone);
  if (day === today) return words.today;
  if (day === yesterday) return words.yesterday;
  const [year, month, date] = day.split('-').map(Number);
  const noon = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1, 12));
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(noon);
}

export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

/**
 * Split a message into text and links, for rendering as text nodes.
 *
 * Only `http:` and `https:` become links - `javascript:`, `data:` and the rest
 * stay the characters they are. The URL is parsed rather than trusted, and a
 * trailing full stop or bracket is left out of it, as a reader would.
 */
export function linkify(body: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of body.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)) {
    const index = match.index;
    let candidate = match[0];
    while (/[.,;:!?)\]]$/.test(candidate)) candidate = candidate.slice(0, -1);
    let href: string | null = null;
    try {
      const url = new URL(candidate);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '') {
        href = url.toString();
      }
    } catch {
      href = null;
    }
    if (href === null) continue;
    if (index > last) parts.push({ kind: 'text', text: body.slice(last, index) });
    parts.push({ kind: 'link', text: candidate, href });
    last = index + candidate.length;
  }
  if (last < body.length) parts.push({ kind: 'text', text: body.slice(last) });
  return parts;
}

/** Initials for an avatar, from a name. Never from an email address. */
export function initialsOf(name: string | null | undefined): string {
  if (name === null || name === undefined) return '';
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
  // Graphemes, not code units: an initial is what a reader sees as one letter.
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const graphemes = (word: string): string[] => Array.from(segmenter.segment(word), (part) => part.segment);
  const letters =
    words.length === 1 ? graphemes(words[0] ?? '').slice(0, 2) : words.slice(0, 2).map((word) => graphemes(word)[0] ?? '');
  return letters.join('').toLocaleUpperCase();
}
