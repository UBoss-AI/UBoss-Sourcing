/**
 * The language picker.
 *
 * Three placements, one control underneath:
 *
 *   - `auth` sits above the sign-in and activation forms. This is the one that
 *     matters most: somebody who cannot read the interface cannot navigate to
 *     a setting buried inside it, so the escape hatch has to be on the first
 *     screen they land on, before they have an account to store it against.
 *   - `header` rides the panel's top bar, next to the account menu.
 *   - `inline` is the plain form for a settings panel.
 *
 * Every option is listed in its own language and never translated into the
 * current one. Somebody stuck in a language they cannot read is scanning for
 * the shape of "Ελληνικά" or "Polski"; rendering that list as "Greek",
 * "Polish" in whatever language they are stuck in is precisely no help.
 *
 * A native `<select>` rather than a custom dropdown, on purpose: it is
 * keyboard- and screen-reader-correct for free, and on a phone it opens the
 * platform's own picker, which handles a Greek option list better than
 * anything we would build.
 */
import { useId } from 'react';
import { cx } from '@/lib/cx';
import { isLanguageCode } from './config';
import { useI18n } from './i18n-context';
import { LANGUAGES } from './languages';

type Placement = 'auth' | 'header' | 'inline';

interface LanguageSwitcherProps {
  placement?: Placement;
  className?: string;
}

export function LanguageSwitcher({
  placement = 'inline',
  className,
}: LanguageSwitcherProps): React.JSX.Element {
  const { language, setLanguage, t } = useI18n();
  const selectId = useId();

  const select = (
    <select
      id={selectId}
      value={language}
      onChange={(event) => {
        const next = event.target.value;
        // The value can only come from the options below, but the DOM is not a
        // type system and a stray value must not put the app in a language
        // that has no catalogue.
        if (isLanguageCode(next)) setLanguage(next);
      }}
      className={cx(
        // `select-chevron` (index.css) replaces the platform arrow, so this
        // sits at the same weight as every other select in the app instead of
        // being whatever shape the operating system felt like drawing.
        'select-chevron rounded-md border bg-surface text-ink',
        placement === 'header'
          ? // Sized to sit level with the account button beside it, and kept
            // narrow: the top bar also has to hold a breadcrumb.
            'h-10 border-border pl-2.5 pr-7 text-xs font-medium'
          : 'h-10 w-full border-border-strong px-3 pr-9 text-sm',
      )}
    >
      {LANGUAGES.map((entry) => (
        <option key={entry.code} value={entry.code}>
          {entry.endonym}
        </option>
      ))}
    </select>
  );

  if (placement === 'header') {
    return (
      <label className={cx('flex items-center', className)}>
        <span className="sr-only">{t('language.label')}</span>
        {select}
      </label>
    );
  }

  if (placement === 'auth') {
    return (
      <div className={cx('mx-auto mb-6 w-full max-w-xs text-left', className)}>
        <label htmlFor={selectId} className="mb-1.5 block text-sm font-medium text-ink">
          {t('language.label')}
        </label>
        {select}
      </div>
    );
  }

  return (
    <div className={className}>
      <label htmlFor={selectId} className="mb-1.5 block text-sm font-medium text-ink">
        {t('language.label')}
      </label>
      {select}
      <p className="mt-1.5 text-xs text-ink-subtle">{t('language.changeAnyTime')}</p>
    </div>
  );
}

/**
 * The "nobody has proofread this yet" notice.
 *
 * Shown under the picker on any non-English language. It is a deliberate
 * admission rather than a hidden risk: these catalogues were translated
 * without a native speaker checking them, and a buyer who spots a wrong term
 * on a checkout screen should know it is worth reporting rather than assume
 * the product means something odd by it.
 *
 * Delete this component - and the `isMachineTranslated` flag behind it - once
 * the catalogues have been reviewed.
 */
export function TranslationQualityNotice({
  className,
}: {
  className?: string;
}): React.JSX.Element | null {
  const { isMachineTranslated, t } = useI18n();

  if (!isMachineTranslated) return null;

  return (
    <p className={cx('text-xs text-ink-subtle', className)}>{t('language.machineTranslated')}</p>
  );
}
