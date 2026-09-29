/**
 * The appearance control: follow the device, light, or dark.
 *
 * **A pill of three options from `sm` up, one cycling button below it.** Two
 * presentations of the same three options, in the same order, and the width is
 * the whole reason:
 *
 *   - **From `sm`,** the pill: three round options side by side, the chosen one
 *     ringed by a border that springs across to whichever is picked next. This
 *     is the one that should exist everywhere: nothing on screen otherwise says
 *     a light theme is on offer, and finding out from a single icon costs a
 *     press and a repaint of the entire page.
 *   - **Below `sm`,** a single icon that advances through them. Not a
 *     preference — a measurement. The band at 345px has about 44px unspoken
 *     for once the brand, the market chip, the account and the basket have
 *     taken theirs, and the pill is 96px. Forcing it in there takes the page
 *     sideways, which is the one thing the storefront's responsive rules say
 *     must never happen. Dropping an *option* instead would be worse: the one
 *     that would go is "match my device", so a phone user who pressed "light"
 *     once could never hand the decision back.
 *
 * The cycling form's accessible name carries the state and says that pressing
 * changes it, because an icon alone cannot.
 *
 * ---
 *
 * **Three options, because `system` is a real answer and not a third look.**
 * "Match my device" is a standing instruction, so somebody whose laptop turns
 * dark at sunset gets a dark storefront at sunset. It is also why the pill
 * rings *which* of the three is chosen rather than which theme is on screen:
 * on a dark machine, following the device and forcing dark look identical and
 * are not.
 *
 * ---
 *
 * **A radio group, one tab stop.** Tab lands on the chosen option; the arrow
 * keys move between the three (wrapping, Home and End to the ends); Enter or
 * Space picks the focused one. Moving does not pick, so arrowing across to see
 * what is on offer does not repaint the whole page three times on the way.
 *
 * **The spring is the only movement, and it stops for reduced motion.** The
 * ring jumps rather than travels when the visitor has asked for less movement.
 * It never takes pointer events, so a press on it lands on the option beneath.
 * Its `layoutId` is scoped with `useId`, so two of these on one page — a
 * header and a drawer — do not pass one ring back and forth between them.
 */
import { useId, useRef, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { useTheme, type ThemePreference } from '@/app/theme-context';
import { DisplayIcon, MoonIcon, SunIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';
import { useI18n } from '@/i18n/i18n-context';

type OptionKey = 'theme.optionSystem' | 'theme.optionLight' | 'theme.optionDark';

interface Option {
  labelKey: OptionKey;
  Icon: (props: { className?: string }) => React.JSX.Element;
}

/**
 * What each preference is called and drawn as.
 *
 * A total `Record` rather than an array searched by preference: every
 * preference has an entry by construction, so looking one up cannot come back
 * undefined and neither form needs a fallback that could never fire.
 */
const OPTIONS: Readonly<Record<ThemePreference, Option>> = {
  system: { labelKey: 'theme.optionSystem', Icon: DisplayIcon },
  light: { labelKey: 'theme.optionLight', Icon: SunIcon },
  dark: { labelKey: 'theme.optionDark', Icon: MoonIcon },
};

/**
 * Device first, then light, then dark.
 *
 * The default leads, and the two explicit answers follow in the order a
 * brightness control runs in. The pill lays them out in this order, the arrow
 * keys walk it, and the compact form advances through it, so the presentations
 * are one list read three ways.
 */
const ORDER: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** What the compact form's next press selects. The ring, stated once. */
const NEXT: Readonly<Record<ThemePreference, ThemePreference>> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

/** The reference design's spring: a little overshoot, settled in 0.6s. */
const SPRING = { type: 'spring', bounce: 0.3, duration: 0.6 } as const;

export function ThemeToggle(): React.JSX.Element {
  const { preference, setPreference } = useTheme();
  const { t } = useI18n();
  const reduceMotion = usePrefersReducedMotion();
  const ringId = useId();
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const current = OPTIONS[preference];
  const CurrentIcon = current.Icon;

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = ORDER.length - 1;
    let target: number;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        target = index === last ? 0 : index + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        target = index === 0 ? last : index - 1;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = last;
        break;
      default:
        return;
    }

    event.preventDefault();
    optionRefs.current[target]?.focus();
  }

  return (
    <>
      {/*
       * The compact form. `sm:hidden` rather than a media-query hook: only one
       * of the two is ever in the accessibility tree, because `display: none`
       * removes it, and doing it in CSS means no resize listener and no
       * first-render flash of the wrong control.
       */}
      <button
        type="button"
        onClick={() => {
          setPreference(NEXT[preference]);
        }}
        className="flex h-10 w-10 shrink-0 cursor-pointer max-[359px]:w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink sm:hidden"
        aria-label={`${t('theme.label')}: ${t(current.labelKey)}. ${t('theme.pressToChange')}`}
        title={`${t('theme.label')}: ${t(current.labelKey)}`}
      >
        <CurrentIcon className="h-5 w-5" />
      </button>

      <div
        role="radiogroup"
        aria-label={t('theme.label')}
        className="hidden shrink-0 items-center overflow-hidden rounded-full bg-surface ring-1 ring-inset ring-border sm:inline-flex"
      >
        {ORDER.map((option, index) => {
          const { labelKey, Icon } = OPTIONS[option];
          const isActive = preference === option;

          return (
            <button
              key={option}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={isActive}
              // The option's own name: the group's label already asks the
              // question, so a screen reader reads "Appearance, radio group,
              // Dark theme, radio button, checked".
              aria-label={t(labelKey)}
              title={t(labelKey)}
              // One tab stop for the set, on the option in force.
              tabIndex={isActive ? 0 : -1}
              onClick={() => {
                setPreference(option);
              }}
              onKeyDown={(event) => {
                onKeyDown(event, index);
              }}
              className={cx(
                'relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition-colors',
                isActive ? 'text-ink' : 'text-ink-subtle hover:text-ink',
              )}
            >
              <Icon className="h-4 w-4" />

              {isActive && (
                <motion.span
                  aria-hidden="true"
                  data-testid="theme-option-ring"
                  layoutId={`theme-option-${ringId}`}
                  transition={reduceMotion ? { duration: 0 } : SPRING}
                  className="pointer-events-none absolute inset-0 rounded-full border border-border-strong"
                />
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}
