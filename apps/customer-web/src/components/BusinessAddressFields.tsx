/**
 * The seller's registered business address, as six fields.
 *
 * ## One component, two screens, on purpose
 *
 * Seller onboarding asks for this address, and the Business Identity editor in
 * the Seller Hub asks for it again so it can be corrected. Those are the same
 * six questions with the same six rules, and writing them twice is how the two
 * screens end up disagreeing about whether a region is required or what a
 * valid PIN code looks like — with the seller finding out at the point where
 * one of them refuses something the other accepted.
 *
 * So this is the whole address: the fields, the layout, the validation
 * messages and the country/region behaviour. Both callers hand it a value and
 * a change handler and render whatever Save button they own. Neither knows
 * what a postcode looks like in Ireland.
 *
 * ## The country
 *
 * A searchable combobox, storing ISO 3166-1 alpha-2 and showing the country's
 * name. Never an index into a list: the list is the operator's `countries`
 * table, its order is a column they can edit, and a stored position would
 * point at a different country the first time somebody reordered it.
 *
 * The list itself comes from `LocaleProvider` — the same server-sent list the
 * storefront's market picker and the seller application already use — rather
 * than from a package of 249 countries bundled into the page. That is the
 * instruction "use the existing utility, do not add the dependency", and it is
 * also the correct answer: the `countries` table is what the rest of the
 * system enforces against, so a second list could only ever disagree with it.
 *
 * ## The region, and the thing it must never do
 *
 * A picker where the country has an official set a business actually writes
 * down (India, the US, Canada, Australia — see `SUBDIVISIONS`), and a plain
 * text box everywhere else. Most of Europe is "everywhere else", and that is
 * correct rather than a gap: forcing somebody in the Netherlands to choose a
 * province they would not have written stores an answer to a question nobody
 * asked.
 *
 * **Changing the country never silently submits an incompatible region.** The
 * old region is kept on screen and the field is marked with a message saying
 * it does not belong to the new country — it is not wiped, because wiping is
 * how somebody loses a value they had typed and only notices after saving. It
 * cannot be saved as it stands either, because the validation objects. The
 * seller chooses, and either choice is one press.
 */
import { useId, useMemo, useRef, useState } from 'react';
import { useLocale } from '@/app/locale-context';
import { Field, Input, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import {
  addressProblemMessage,
  regionCodeOf,
  regionForStorage,
  regionNameOf,
  subdivisionsFor,
} from '@/lib/business-address';
import type { AddressField, AddressProblems, BusinessAddress } from '@/lib/business-address';

/**
 * A searchable country picker over the deployment's own country list.
 *
 * Built here rather than reached for off a shelf, and it is worth saying why
 * given how much of a combobox is fiddly: this app already has one in
 * `AddressSuggest`, built on the same `Field`/`Input` pair with the same ARIA
 * and the same blur timing. This is that pattern against a local array instead
 * of a network search — no debounce, no query, no loading state — and it keeps
 * the two consistent, which a dependency would not.
 *
 * Keyboard: Down and Up move, Enter chooses, Escape closes without choosing,
 * Tab leaves. `aria-activedescendant` is what a screen reader follows, so the
 * highlighted row is announced without focus ever leaving the input.
 */
function CountryCombobox({
  value,
  onChange,
  error,
  disabled = false,
}: {
  /** ISO alpha-2, or '' for nothing chosen. */
  value: string;
  onChange: (code: string) => void;
  error?: string | undefined;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const locale = useLocale();
  const listId = useId();

  const [query, setQuery] = useState<string | null>(null);
  const [isOpen, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const chosen = useMemo(
    () => locale.countries.find((entry) => entry.code === value) ?? null,
    [locale.countries, value],
  );

  /*
   * What is in the box.
   *
   * `null` means "not being edited", and the box then shows the chosen
   * country's NAME — which is the requirement: display "India", store "IN".
   * The moment somebody types, `query` holds their text and the box shows that
   * instead, because a search field that keeps overwriting what is typed with
   * the previous answer is unusable.
   */
  const text = query ?? chosen?.name ?? '';

  const matches = useMemo(() => {
    const needle = (query ?? '').trim().toLowerCase();
    if (needle.length === 0) return locale.countries;

    // Name first, then code, so typing "in" offers India before Indonesia and
    // before every country whose name merely contains those letters. Starts-
    // with beats contains for the same reason.
    return locale.countries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) || entry.code.toLowerCase() === needle,
    );
  }, [locale.countries, query]);

  const choose = (code: string): void => {
    onChange(code);
    setQuery(null);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      // Back to the chosen country, not to an empty box: Escape cancels the
      // search, it does not clear the answer.
      setQuery(null);
      setOpen(false);
      return;
    }

    if (!isOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setOpen(true);
      return;
    }

    if (!isOpen || matches.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % matches.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index - 1 + matches.length) % matches.length);
      return;
    }

    if (event.key === 'Enter') {
      const picked = matches[active];
      if (picked === undefined) return;
      // Only while the list is open with something highlighted, so Enter still
      // submits the form the rest of the time.
      event.preventDefault();
      choose(picked.code);
    }
  };

  return (
    <Field
      label={t('sellerAddress.country')}
      required
      {...(error === undefined ? {} : { error })}
    >
      {({ inputId, describedBy }) => (
        <div className="relative">
          <Input
            id={inputId}
            aria-describedby={describedBy}
            role="combobox"
            aria-expanded={isOpen}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              isOpen && matches.length > 0 ? `${listId}-${String(active)}` : undefined
            }
            // `country` and not `country-name`: the value this control produces
            // is the two-letter code, and `country` is the autofill token for
            // exactly that. Naming the wrong one has the browser fill a name
            // into a field that stores a code.
            autoComplete="country"
            invalid={error !== undefined}
            disabled={disabled}
            placeholder={t('sellerAddress.countryPlaceholder')}
            value={text}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => {
              setOpen(true);
            }}
            onBlur={() => {
              /*
               * After the click, not before it. A pointer press on an option
               * blurs the input first, and closing here and now unmounts the
               * row under the finger. The options guard this with
               * `onMouseDown` too; the delay covers a touch drag that never
               * fires `mousedown` at all. Same pair of braces as
               * `AddressSuggest`.
               */
              blurTimer.current = setTimeout(() => {
                setOpen(false);
                // The typed text goes away with the list, so the box returns
                // to showing the country that is actually stored. Somebody who
                // typed "Ind" and clicked away has chosen nothing, and leaving
                // "Ind" in a box that stores a code would say otherwise.
                setQuery(null);
              }, 150);
            }}
            onKeyDown={onKeyDown}
          />

          {isOpen && (
            <ul
              id={listId}
              role="listbox"
              aria-label={t('sellerAddress.country')}
              className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border-strong bg-surface py-1 shadow-lg"
            >
              {matches.length === 0 && (
                <li className="px-3 py-2 text-xs text-ink-muted">
                  {t('sellerAddress.noCountryMatches')}
                </li>
              )}

              {matches.map((entry, index) => (
                <li key={entry.code}>
                  <button
                    type="button"
                    id={`${listId}-${String(index)}`}
                    role="option"
                    aria-selected={index === active}
                    className={cx(
                      'flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm text-ink transition-colors',
                      index === active ? 'bg-surface-sunken' : 'hover:bg-surface-sunken',
                    )}
                    onMouseEnter={() => {
                      setActive(index);
                    }}
                    onMouseDown={(event) => {
                      // Keeps the blur above from firing before the click.
                      event.preventDefault();
                      if (blurTimer.current !== null) clearTimeout(blurTimer.current);
                    }}
                    onClick={() => {
                      choose(entry.code);
                    }}
                  >
                    <span className="truncate">{entry.name}</span>
                    {/* The code, quietly. It is what is stored, and a seller
                        checking their own application against a certificate
                        should be able to see it without guessing. */}
                    <span className="shrink-0 font-mono text-xxs text-ink-subtle">
                      {entry.code}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Announced rather than drawn: a sighted person sees the list, and
              a screen reader is told how many rows are in it. */}
          <span className="sr-only" role="status">
            {isOpen ? t('sellerAddress.countryMatches', { count: matches.length }) : ''}
          </span>
        </div>
      )}
    </Field>
  );
}

export function BusinessAddressFields({
  value,
  onChange,
  problems = {},
  disabled = false,
}: {
  value: BusinessAddress;
  onChange: (next: BusinessAddress) => void;
  /** What validation objected to, keyed by field. Rendered against each input. */
  problems?: AddressProblems;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();

  const set = (field: AddressField, next: string): void => {
    onChange({ ...value, [field]: next });
  };

  const options = subdivisionsFor(value.country);

  /*
   * Whether the stored region belongs to the country now chosen.
   *
   * Only ever false after somebody CHANGES the country with a region already
   * filled in — which is the case the brief singles out, and rightly: silently
   * submitting "Gujarat" against a German address would put a meaningless
   * string on a tax registration.
   *
   * The answer is neither to wipe it nor to let it through. It stays on
   * screen, so nothing somebody typed disappears, and it is called out in
   * words directly under the field with a one-press way to clear it. The
   * ordinary required-field validation does the rest: the picker's value is
   * not one of its options, so the field reads as empty to the form and Save
   * objects.
   */
  const regionCode = regionCodeOf(value.region);

  const regionMismatch =
    value.region.trim().length > 0 &&
    (options === null
      ? /*
         * The new country has no list, and the value came from one.
         *
         * A bracketed code can only have been written by `regionForStorage`
         * from a picker, so "Uttar Pradesh (UP)" sitting in a free-text box
         * under a German address is an Indian state that followed the seller
         * across a country change. Free text that was always free text —
         * "Noord-Holland" — is left alone, because there is nothing to say
         * about it: it was typed, and it is still typeable.
         */
        regionCode !== null
      : // The new country HAS a list and the value is not on it.
        !options.some(
          (option) => option.code === regionCode || option.name === regionNameOf(value.region),
        ));

  /** The picker's current value: the code, or '' where nothing matches it. */
  const regionSelectValue =
    options === null || regionMismatch
      ? ''
      : (regionCode ??
        options.find((option) => option.name === regionNameOf(value.region))?.code ??
        '');

  return (
    <div className="space-y-4">
      {/* Full width: a street line is the longest thing on this form and the
          one most likely to be a genuine mouthful. */}
      <Field
        label={t('sellerAddress.line1')}
        required
        {...(addressProblemMessage(t, 'line1', problems.line1) === undefined
          ? {}
          : { error: addressProblemMessage(t, 'line1', problems.line1) })}
      >
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            autoComplete="address-line1"
            maxLength={200}
            disabled={disabled}
            invalid={problems.line1 !== undefined}
            value={value.line1}
            onChange={(event) => {
              // Read out of the event before the state update: React clears
              // `currentTarget` on the synthetic event by the time a functional
              // updater runs, and reading it in there throws. The onboarding
              // form learned this the hard way — see `RequirementForm`.
              const { value: next } = event.currentTarget;
              set('line1', next);
            }}
          />
        )}
      </Field>

      <Field
        label={t('sellerAddress.line2')}
        hint={t('sellerAddress.line2Hint')}
        {...(addressProblemMessage(t, 'line2', problems.line2) === undefined
          ? {}
          : { error: addressProblemMessage(t, 'line2', problems.line2) })}
      >
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            autoComplete="address-line2"
            maxLength={200}
            disabled={disabled}
            value={value.line2}
            onChange={(event) => {
              const { value: next } = event.currentTarget;
              set('line2', next);
            }}
          />
        )}
      </Field>

      {/* Two columns from `sm` up and stacked below it, which is the whole of
          the responsive behaviour this form needs: these are short fields, and
          a phone has room for one of them at a time. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label={t('sellerAddress.city')}
          required
          {...(addressProblemMessage(t, 'city', problems.city) === undefined
            ? {}
            : { error: addressProblemMessage(t, 'city', problems.city) })}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              autoComplete="address-level2"
              maxLength={100}
              disabled={disabled}
              invalid={problems.city !== undefined}
              value={value.city}
              onChange={(event) => {
                const { value: next } = event.currentTarget;
                set('city', next);
              }}
            />
          )}
        </Field>

        <div>
          {options === null ? (
            /* No official list for this country, so a text box — which is the
               right control rather than a fallback. See the note on
               `SUBDIVISIONS`. */
            <Field
              label={t('sellerAddress.region')}
              required
              {...(addressProblemMessage(t, 'region', problems.region) === undefined
                ? {}
                : { error: addressProblemMessage(t, 'region', problems.region) })}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  autoComplete="address-level1"
                  maxLength={100}
                  disabled={disabled}
                  invalid={problems.region !== undefined}
                  value={value.region}
                  onChange={(event) => {
                    const { value: next } = event.currentTarget;
                    set('region', next);
                  }}
                />
              )}
            </Field>
          ) : (
            <Field
              label={t('sellerAddress.region')}
              required
              {...(addressProblemMessage(t, 'region', problems.region) === undefined
                ? {}
                : { error: addressProblemMessage(t, 'region', problems.region) })}
            >
              {({ inputId, describedBy }) => (
                /*
                 * A native `<select>` rather than a second combobox.
                 *
                 * It is searchable already — every browser jumps to the option
                 * you type the first letters of — it is the control a phone
                 * renders as its own wheel, and the longest of these lists is
                 * 53 rows. A custom listbox here would be more code for a
                 * worse control on the device most likely to be filling this
                 * in.
                 */
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  autoComplete="address-level1"
                  disabled={disabled}
                  invalid={problems.region !== undefined}
                  value={regionSelectValue}
                  onChange={(event) => {
                    const { value: code } = event.currentTarget;
                    const picked = options.find((option) => option.code === code) ?? null;
                    // Stored as "Name (CODE)" — readable on its own and with
                    // the code recoverable exactly. See `regionForStorage`.
                    set('region', regionForStorage(picked) ?? '');
                  }}
                >
                  <option value="">{t('sellerAddress.regionPlaceholder')}</option>
                  {options.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          {/*
            The country changed and the region no longer belongs to it.

            Said in words, with a button, rather than done silently. `role="alert"`
            because it appears in response to something that just happened
            elsewhere on the form, and somebody who cannot see the field change
            has no other way to learn that the value they entered has stopped
            being valid.
          */}
          {regionMismatch && (
            <div
              role="alert"
              className="mt-1.5 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-ink"
            >
              <p>
                {t('sellerAddress.regionNoLongerValid', {
                  region: regionNameOf(value.region) ?? value.region,
                })}
              </p>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  set('region', '');
                }}
                className="mt-1 font-semibold text-ink underline underline-offset-2 hover:no-underline"
              >
                {t('sellerAddress.clearRegion')}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label={t('sellerAddress.postcode')}
          {...(addressProblemMessage(t, 'postcode', problems.postcode) === undefined
            ? {}
            : { error: addressProblemMessage(t, 'postcode', problems.postcode) })}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              autoComplete="postal-code"
              // `text`, never `number`. A postal code is a string everywhere in
              // this system precisely so a leading zero survives: `type="number"`
              // would let a browser hand back 1234 for "01234", and 01234 is a
              // real place in Massachusetts.
              type="text"
              // `inputMode` is a keyboard hint, not a constraint. Left off
              // deliberately: half the postal systems here are alphanumeric, and
              // a numeric keypad in front of somebody typing "SW1A 1AA" is a
              // worse default than the ordinary keyboard.
              maxLength={20}
              disabled={disabled}
              invalid={problems.postcode !== undefined}
              value={value.postcode}
              onChange={(event) => {
                const { value: next } = event.currentTarget;
                set('postcode', next);
              }}
            />
          )}
        </Field>

        <CountryCombobox
          value={value.country}
          disabled={disabled}
          {...(addressProblemMessage(t, 'country', problems.country) === undefined
            ? {}
            : { error: addressProblemMessage(t, 'country', problems.country) })}
          onChange={(code) => {
            // The country and nothing else. The region is deliberately left
            // exactly as it is — see `regionMismatch` above for why wiping it
            // would be the wrong kindness.
            onChange({ ...value, country: code });
          }}
        />
      </div>
    </div>
  );
}
