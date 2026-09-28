/**
 * The numeral with a ghost standing in for its zero.
 *
 * "4 👻 4", "5 👻 3", and for the two kinds with no status — offline, and a
 * script that failed to load — the ghost on its own. A code with no zero in it
 * (429) keeps its digits and the ghost floats above them.
 *
 * **The ghost is drawn here, not fetched.** The design it comes from loads a
 * PNG from a third-party CDN. That would be blocked by the production
 * `img-src 'self'` policy, would be the one thing missing on the offline
 * page, and would tell a stranger's server about every visitor who hit an
 * error. As an inline SVG it follows the theme too: its body is
 * `--surface-raised`, its outline and glow `--brand`, its eyes `--ink`.
 *
 * **Decoration only.** The whole scene is `aria-hidden`; the page states the
 * code in words for assistive technology.
 *
 * **Reduced motion gets the finished frame.** No entrance, no float, no hover
 * wiggle — the digits and the ghost are simply where they end up.
 */
import { motion, type Variants } from 'motion/react';
import { cx } from '@/lib/cx';

/** The reference design's curve: a quick start, a long, soft landing. */
const EASE = [0.43, 0.13, 0.23, 0.96] as const;

const numberVariants: Variants = {
  hidden: (direction: number) => ({
    opacity: 0,
    x: direction * 40,
    y: 15,
    rotate: direction * 5,
  }),
  visible: {
    opacity: 1,
    x: 0,
    y: 0,
    rotate: 0,
    transition: { duration: 0.8, ease: EASE },
  },
};

const ghostVariants: Variants = {
  hidden: { scale: 0.8, opacity: 0, y: 15, rotate: -5 },
  visible: {
    scale: 1,
    opacity: 1,
    y: 0,
    rotate: 0,
    transition: { duration: 0.6, ease: EASE },
  },
  floating: {
    y: [-5, 5],
    transition: {
      y: { duration: 2, ease: 'easeInOut', repeat: Infinity, repeatType: 'reverse' },
    },
  },
  hover: {
    scale: 1.1,
    y: -10,
    rotate: [0, -5, 5, -5, 0],
    transition: {
      duration: 0.8,
      ease: 'easeInOut',
      rotate: { duration: 2, ease: 'linear', repeat: Infinity, repeatType: 'reverse' },
    },
  },
};

/** The numeral's type: large, heavy, and shaded from ink down into brand blue. */
const DIGIT =
  'select-none bg-gradient-to-b from-ink to-brand bg-clip-text text-[80px] font-bold leading-none ' +
  'tracking-tight text-transparent sm:text-[120px]';

function Ghost({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 120 144"
      className={cx('overflow-visible', className)}
      style={{ filter: 'drop-shadow(0 10px 22px rgb(var(--brand) / 0.35))' }}
      focusable="false"
    >
      {/* Body: a dome, and four lobes along the hem. */}
      <path
        d="M20 62C20 33 38 12 60 12s40 21 40 50v56q-10 16-20 0q-10 16-20 0q-10 16-20 0q-10 16-20 0Z"
        className="fill-surface-raised stroke-brand"
        strokeWidth={3}
        strokeLinejoin="round"
      />
      {/* Cheeks. */}
      <circle cx="38" cy="76" r="6" className="fill-brand/20" />
      <circle cx="82" cy="76" r="6" className="fill-brand/20" />
      {/* Eyes, each with a highlight so they read as looking, not as holes. */}
      <ellipse cx="46" cy="60" rx="7" ry="9" className="fill-ink" />
      <ellipse cx="74" cy="60" rx="7" ry="9" className="fill-ink" />
      <circle cx="48.5" cy="56.5" r="2.2" className="fill-surface-raised" />
      <circle cx="76.5" cy="56.5" r="2.2" className="fill-surface-raised" />
      {/* A small "oh". */}
      <ellipse cx="60" cy="82" rx="5" ry="6" className="fill-ink" />
    </svg>
  );
}

export function GhostScene({
  statusCode,
  reduceMotion,
}: {
  statusCode: number | null;
  reduceMotion: boolean;
}): React.JSX.Element {
  const digits = statusCode === null ? [] : String(statusCode).split('');
  const zeroAt = digits.indexOf('0');
  const ghostAlone = digits.length === 0;
  const ghostAbove = !ghostAlone && zeroAt === -1;

  const ghost = (
    <motion.div
      data-testid="error-ghost"
      data-motion={reduceMotion ? 'still' : 'floating'}
      variants={ghostVariants}
      initial={reduceMotion ? false : 'hidden'}
      animate={reduceMotion ? 'visible' : ['visible', 'floating']}
      {...(reduceMotion ? {} : { whileHover: 'hover' })}
      className="shrink-0"
    >
      <Ghost
        className={
          ghostAlone
            ? 'h-[120px] w-[100px] sm:h-[168px] sm:w-[140px]'
            : 'h-[88px] w-[74px] sm:h-[132px] sm:w-[110px]'
        }
      />
    </motion.div>
  );

  return (
    <div
      aria-hidden="true"
      className="mb-8 flex flex-col items-center justify-center gap-2 sm:mb-12"
    >
      {(ghostAlone || ghostAbove) && ghost}

      {!ghostAlone && (
        <div className="flex items-center justify-center gap-3 sm:gap-6">
          {digits.map((digit, index) => {
            if (index === zeroAt) return <div key={index}>{ghost}</div>;

            // Digits slide in from their own side of the middle; a digit
            // standing in the middle itself rises straight up.
            const middle = zeroAt === -1 ? (digits.length - 1) / 2 : zeroAt;
            const direction = Math.sign(index - middle);

            return (
              <motion.span
                key={index}
                className={DIGIT}
                variants={numberVariants}
                custom={direction}
                initial={reduceMotion ? false : 'hidden'}
                animate="visible"
              >
                {digit}
              </motion.span>
            );
          })}
        </div>
      )}
    </div>
  );
}
