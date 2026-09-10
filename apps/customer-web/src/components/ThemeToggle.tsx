/**
 * The appearance control: light, dark, or follow the device.
 *
 * **A segmented control from `sm` up, one cycling button below it.** Two
 * presentations of the same three options, in the same order, and the width is
 * the whole reason:
 *
 *   - **From `sm`,** three segments side by side. This is the one that should
 *     exist everywhere: nothing on screen otherwise says a light theme is on
 *     offer, and finding out from a single icon costs a press and a repaint of
 *     the entire page. Three segments say what the choice is and reach any of
 *     them in one press.
 *   - **Below `sm`,** a single icon that advances through them. Not a
 *     preference — a measurement. The band at 345px has about 44px unspoken
 *     for once the brand, the market chip, the account and the basket have
 *     taken theirs, and the segmented group is 109px. Forcing it in there
 *     takes the page sideways, which is the one thing the storefront's
 *     responsive rules say must never happen. Dropping a *segment* instead
 *     would be worse: the option that would go is "match my device", so a
 *     phone user who pressed "light" once could never hand the decision back.
 *
 * The cycling form's accessible name carries the state and says that pressing
 * changes it, because an icon alone cannot.
 *
 * ---
 *
 * **Three options, because `system` is a real answer and not a third look.**
 * "Match my device" is a standing instruction, so somebody whose laptop turns
 * dark at sunset gets a dark storefront at sunset. Dropping it to make a
 * two-position switch would mean the first press on this control silently
 * signed the visitor out of that behaviour forever, which is not what pressing
 * "dark" once means. It is also why the segmented form shows *which* of the
 * three is selected rather than which theme is on screen: on a dark machine,
 * following the device and forcing dark look identical and are not.
 *
 * ---
 *
 * **`aria-pressed` on each segment, inside a labelled group.** Not
 * `role="radiogroup"`: that promises arrow-key navigation between the options
 * and one tab stop for the set, which is the right pattern for a form field
 * somebody submits and the wrong one for three buttons that each take effect
 * the moment they are pressed. Each segment is a toggle button reporting
 * whether it is the one in force, and the group carries the question they
 * answer.
 */
import { useTheme, type ThemePreference } from '@/app/theme-context';
import { DisplayIcon, MoonIcon, SunIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
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
 * brightness control runs in. The segmented form lays them out in this order
 * and the compact form advances through it, so the two presentations are one
 * list read two ways.
 */
const ORDER: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** What the compact form's next press selects. The ring, stated once. */
const NEXT: Readonly<Record<ThemePreference, ThemePreference>> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

export function ThemeToggle(): React.JSX.Element {
  const { preference, setPreference } = useTheme();
  const { t } = useI18n();

  const current = OPTIONS[preference];
  const CurrentIcon = current.Icon;

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
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink sm:hidden"
        aria-label={`${t('theme.label')}: ${t(current.labelKey)}. ${t('theme.pressToChange')}`}
        title={`${t('theme.label')}: ${t(current.labelKey)}`}
      >
        <CurrentIcon className="h-5 w-5" />
      </button>

      <div
        role="group"
        aria-label={t('theme.label')}
        // Sunken, so the selected segment reads as a tile lifted out of a
        // recess. On a flat ground the selected state has to be carried by
        // colour alone, and at 16px an icon in brand blue beside an icon in
        // grey is not a difference somebody notices in passing.
        className="hidden h-10 shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface-sunken p-1 sm:flex"
      >
        {ORDER.map((option) => {
          const { labelKey, Icon } = OPTIONS[option];
          const isSelected = preference === option;

          return (
            <button
              key={option}
              type="button"
              aria-pressed={isSelected}
              // The option's own name, not "switch to X": the group's label
              // already asks the question, so a screen reader reads
              // "Appearance, Dark theme, toggle button, pressed".
              aria-label={t(labelKey)}
              title={t(labelKey)}
              onClick={() => {
                setPreference(option);
              }}
              className={cx(
                'flex h-8 w-8 items-center justify-center rounded transition-colors',
                isSelected
                  ? 'bg-surface text-brand shadow-card'
                  : 'text-ink-subtle hover:bg-surface-hover hover:text-ink',
              )}
            >
              <Icon className="h-4 w-4" />
            </button>
          );
        })}
      </div>
    </>
  );
}
