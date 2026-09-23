/**
 * The text that changes.
 *
 * One entry in a line of text is swapped for the next every few seconds. The
 * outgoing entry blurs, grows and drifts up and to the right; the incoming one
 * arrives letter by letter, each letter a little later than the one before it,
 * so it assembles rather than appears. An entry may be a single word or a
 * whole phrase — a phrase animates word by word and each word letter by
 * letter, so a long one lands as one movement rather than fifty.
 *
 * It is on the greeting, in the line under the shop's name, where it alternates
 * the strapline with `Powered by UBOSS`, and it is the one thing on that line
 * that moves. The 3D stage behind it is atmosphere; this is the sentence, so it
 * is the piece a visitor actually reads.
 *
 * ---
 *
 * WHERE THIS CAME FROM, AND WHAT HAD TO CHANGE
 *
 * The shape of this is the Aceternity `flip-words` component. Six things about
 * it could not survive contact with this repository — the same list
 * `ui/background-gradient.tsx` and `ui/3d-globe.tsx` keep, for the same
 * reason.
 *
 *   - **`cn` is `cx`.** This project's class joiner is `lib/cx.ts`. There is
 *     no `clsx`/`tailwind-merge` pair here, and adding one to satisfy an
 *     import would be two dependencies for one function.
 *   - **The timer is cleaned up, and it is armed off a length.** The original
 *     schedules a `setTimeout` in an effect that never clears it, and depends
 *     on the `words` array itself. A caller writing `words={['a', 'b']}` inline
 *     — which is exactly how the original's own demo is written — hands it a
 *     new array on every render, so the effect re-runs on every render and
 *     leaves another live timer behind each time. Within a minute the word is
 *     flipping many times a second. Here the effect depends on `words.length`,
 *     a number, and clears its timer on the way out.
 *   - **The next word is an index, not a lookup.** The original finds the
 *     current word with `words.indexOf(currentWord)`, which means a list with
 *     the same word twice cycles the first occurrence forever. Counting is
 *     cheaper and cannot be wrong.
 *   - **`prefers-reduced-motion` gets a still word.** Text that rewrites
 *     itself under the reader is the exact thing that preference is asking to
 *     be spared, and a blur-and-scale exit is worse than a carousel. Under it
 *     there is no animation, no timer and no `AnimatePresence`: the first word
 *     is rendered and left alone. `docs/ACCESSIBILITY.md` has the rule.
 *   - **A screen reader is told one word, once.** The animation splits the
 *     word into a span per letter, which a screen reader is entitled to read
 *     out letter by letter, and re-reads the whole line every time the word
 *     changes. So the moving copy is `aria-hidden` and one steady `sr-only`
 *     word carries the meaning — the line reads as a sentence, and it reads
 *     once.
 *   - **The exiting word is contained.** The exit animation sets
 *     `position: absolute`, which positions against the nearest positioned
 *     ancestor — and on the greeting that is the hero `<section>`, so the
 *     outgoing word flew to the card's top-left corner on the way out. The
 *     wrapper here is `relative`, so "absolute" means "where the word already
 *     was".
 *
 * A hidden tab parks it rather than queueing it up: the timer is only re-armed
 * once the outgoing word has finished leaving, and nothing finishes leaving
 * while `requestAnimationFrame` is not running. See the note in
 * `greeting/HeroStage.tsx` for the same behaviour in the scene behind it.
 */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cx } from '@/lib/cx';

interface FlipWordsProps {
  /** The words to cycle through, in order. One word, or none, never moves. */
  words: string[];
  /** How long a word stays up, in milliseconds, before the next one starts. */
  duration?: number;
  /** On the word itself. Type size and colour belong to the caller. */
  className?: string;
  /**
   * What a screen reader is told, once, instead of the rotation.
   *
   * The default is the first word, which is right when the rotation is one
   * word in a sentence the rest of the line already carries. It is wrong when
   * every entry is a whole phrase and each phrase says something different:
   * announcing only the first would leave the others unreachable, and
   * announcing them as they change would re-read the line every few seconds.
   *
   * A caller in that position passes one steady sentence covering all of them.
   * It is still read once, and it still never changes — which is the property
   * that matters, and the reason this is not an `aria-live` region.
   */
  srLabel?: string;
}

/**
 * Whether this visitor has asked for less movement.
 *
 * Read straight from the media query rather than through motion's own
 * `useReducedMotion`, which is what `greeting/HeroStage.tsx`,
 * `greeting/SourcingHub.tsx` and `EarthMark.tsx` all do, for the same two
 * reasons: the preference is answered here by not rendering an animation at
 * all rather than by damping one, and motion's hook resolves the query once
 * per page and caches it, which is fine in a browser and untestable in a
 * suite that has to render both answers.
 *
 * Subscribed, not sampled: somebody who turns the preference on mid-visit gets
 * a still word from that moment, not at the next page load.
 */
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * The media query, or nothing.
 *
 * jsdom does not implement `matchMedia`, so a test that mounts a page
 * containing this would otherwise die on a call it is not asking about. The
 * theme provider guards the same call for the same reason - see the note in
 * `test/harness.tsx`. Absent means "no preference expressed", which is the
 * answer every browser that does implement it gives by default.
 */
function reduceQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(REDUCE_QUERY) : null;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reduceQuery()?.matches ?? false);

  useEffect(() => {
    const query = reduceQuery();
    if (query === null) return undefined;

    const settle = (): void => {
      setReduced(query.matches);
    };

    settle();
    query.addEventListener('change', settle);

    return () => {
      query.removeEventListener('change', settle);
    };
  }, []);

  return reduced;
}

/**
 * Letters, the way a reader counts them.
 *
 * Not `split('')`, which cuts UTF-16 code units, and not the spread operator,
 * which cuts code points. This storefront is read in eight languages: Greek
 * writes a vowel and its diacritic as two code points that are one letter, and
 * a word cut between them animates a bare accent drifting in on its own. A
 * grapheme is the unit a person would point at.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function lettersOf(word: string): string[] {
  return [...GRAPHEMES.segment(word)].map((piece) => piece.segment);
}

/** Seconds a letter waits behind the letter before it. */
const LETTER_STAGGER = 0.05;

/** Seconds a word waits behind the word before it, in a multi-word phrase. */
const WORD_STAGGER = 0.3;

export function FlipWords({
  words,
  duration = 3000,
  className,
  srLabel,
}: FlipWordsProps): React.JSX.Element {
  const reduced = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  // True from the moment the word changes until the old one has finished
  // leaving. The next timer is armed off the back of that rather than off a
  // fixed interval, so the two words are never on screen fighting each other.
  const [isLeaving, setIsLeaving] = useState(false);

  const count = words.length;
  const resting = words[0] ?? '';
  const current = words[index] ?? resting;
  // A phrase animates word by word and each word letter by letter, so the
  // split happens once here rather than again inside every letter.
  const parts = current.split(' ');

  useEffect(() => {
    if (reduced || isLeaving || count < 2) return undefined;

    const timer = window.setTimeout(() => {
      setIndex((previous) => (previous + 1) % count);
      setIsLeaving(true);
    }, duration);

    return () => {
      window.clearTimeout(timer);
    };
  }, [reduced, isLeaving, count, duration]);

  if (reduced) {
    // No timer, no `AnimatePresence`, and only the first entry ever drawn.
    //
    // Where the caller has given a label covering the whole rotation, the
    // still copy is hidden from assistive technology and the label is read
    // instead — so a reduced-motion visitor is told the same complete message
    // as everybody else, rather than only whichever phrase happens to be
    // first. Once, and never again, because nothing here changes.
    if (srLabel !== undefined) {
      return (
        <span className={cx('inline-block', className)}>
          <span className="sr-only">{srLabel}</span>
          <span aria-hidden="true">{resting}</span>
        </span>
      );
    }

    return <span className={cx('inline-block', className)}>{resting}</span>;
  }

  return (
    <span className="relative inline-block align-baseline">
      {/* What the line actually says, for anything that is not watching it. */}
      <span className="sr-only">{srLabel ?? resting}</span>

      <AnimatePresence
        onExitComplete={() => {
          setIsLeaving(false);
        }}
      >
        <motion.span
          // Indexed as well as named: a list with the same word twice would
          // otherwise hand AnimatePresence two children under one key.
          key={`${index}:${current}`}
          aria-hidden="true"
          // Every property the exit animates is declared here too, with a
          // starting value. A property that appears for the first time in
          // `exit` has nothing to travel from, and motion writes it into the
          // style attribute as the literal string "undefined" on the way past.
          initial={{ opacity: 0, y: 10, x: 0, scale: 1, filter: 'blur(0px)' }}
          animate={{ opacity: 1, y: 0, x: 0, scale: 1, filter: 'blur(0px)' }}
          transition={{ type: 'spring', stiffness: 100, damping: 10 }}
          exit={{
            opacity: 0,
            y: -40,
            x: 40,
            filter: 'blur(8px)',
            scale: 2,
            // Out of flow, so the wrapper is already the width of the word
            // arriving rather than the one leaving. Not animated - a value
            // with no numeric distance to cover is applied at once.
            position: 'absolute',
            // A tween, where the entrance is a spring.
            //
            // `AnimatePresence` only re-renders - and only calls
            // `onExitComplete` - once every exiting property has settled, and
            // a spring settles when it decides it has. Under the shared spring
            // above, the exit sometimes never reported finishing, the timer
            // was never re-armed, and the word stopped changing two flips in
            // with both copies left in the DOM. A duration cannot do that.
            transition: { duration: 0.4, ease: 'easeIn' },
          }}
          className={cx('inline-block text-left', className)}
        >
          {parts.map((word, wordIndex) => (
            <motion.span
              key={`${wordIndex}:${word}`}
              initial={{ opacity: 0, y: 10, filter: 'blur(8px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ delay: wordIndex * WORD_STAGGER, duration: 0.3 }}
              className="inline-block whitespace-nowrap"
            >
              {lettersOf(word).map((letter, letterIndex) => (
                <motion.span
                  key={`${letterIndex}:${letter}`}
                  initial={{ opacity: 0, y: 10, filter: 'blur(8px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  transition={{
                    delay: wordIndex * WORD_STAGGER + letterIndex * LETTER_STAGGER,
                    duration: 0.2,
                  }}
                  className="inline-block"
                >
                  {letter}
                </motion.span>
              ))}
              {/* The space the split ate - between words, never after the
                  last one, which would pad the word with a space it does
                  not have and shift the line as the words swap. */}
              {wordIndex < parts.length - 1 && <span className="inline-block">&nbsp;</span>}
            </motion.span>
          ))}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
