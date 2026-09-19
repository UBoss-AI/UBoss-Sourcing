/**
 * An address field that offers the real places matching what is typed.
 *
 * The problem it solves is not typing speed. An address and its coordinates
 * are two records of the same fact, and every screen that let somebody type
 * the first and then press a button for the second could end up holding two
 * that disagree - a street typed slightly wrong, a geocoder's confident first
 * guess in the next town, and a warehouse drawn somewhere nobody has ever
 * been. Choosing a place from a list makes them one decision: the address
 * that goes on the paperwork and the pin that goes on the map come from the
 * same row.
 *
 * Four things worth knowing about how it behaves.
 *
 * **It is an ordinary text field first.** Everything still works with the
 * suggestions switched off, unreachable or simply ignorant of the street -
 * which is what an installation with no `GEOCODE_FORWARD_URL` has, and that is
 * a supported way to run this software rather than a fault. The dropdown never
 * opens, and what is typed is what is saved.
 *
 * **Nothing is filled in until somebody picks.** Typing never moves the
 * coordinates, so a half-written street cannot leave a pin behind it. The
 * fields change on the choice and not before.
 *
 * **The query is narrowed by what is already known.** `context` carries the
 * city and country already chosen on the form, so a search for "Grote Markt"
 * from a Belgian warehouse does not offer one in Poland.
 *
 * **It waits before asking.** A keystroke is not a search. The pause below is
 * what keeps one address from spending thirty requests of the deployment's
 * geocoder quota, which on OpenStreetMap's public instance is the difference
 * between being inside their usage policy and being blocked.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Field, Input, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/i18n/i18n-context';

/**
 * One place the geocoder offered.
 *
 * Every part is nullable because a geocoder is allowed to know where somewhere
 * is without knowing its postcode. A caller fills a field from a null by
 * leaving it alone, never by clearing it - overwriting a typed postcode with
 * an empty string is destroying a fact to make a screen tidier.
 */
export interface AddressSuggestion {
  latitude: number;
  longitude: number;
  label: string | null;
  line1: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
}

interface SuggestResponse {
  suggestions: AddressSuggestion[];
}

/**
 * How long a field waits after the last keystroke.
 *
 * Long enough that typing a street is one request rather than twenty, short
 * enough that the list is there by the time somebody has stopped to look for
 * it. Tuned by hand rather than derived: the interesting number is the pause
 * between words, not the interval between letters.
 */
const DEBOUNCE_MS = 350;

/**
 * Below this, a search matches half a country.
 *
 * Two characters of a street name is not a question anybody can answer, and
 * asking it anyway spends quota to return noise.
 */
const MIN_QUERY = 3;

export function AddressSuggest({
  endpoint,
  label,
  hint,
  error,
  required,
  value,
  onChange,
  onPick,
  context,
  maxLength,
  placeholder,
}: {
  /** The suggest endpoint for this caller's audience. */
  endpoint: string;
  label: string;
  hint?: string;
  /** A validation message from the form this field belongs to. */
  error?: string | undefined;
  required?: boolean;
  value: string;
  /** Ordinary typing. Never carries coordinates - only `onPick` does. */
  onChange: (value: string) => void;
  /** Somebody chose a place. The whole address and its pin, together. */
  onPick: (suggestion: AddressSuggestion) => void;
  /**
   * What is already known, appended to the search.
   *
   * The city and country chosen elsewhere on the form, in whatever order reads
   * as an address. Empty is fine; it simply searches the world.
   */
  context?: string;
  maxLength?: number;
  placeholder?: string;
}): React.JSX.Element {
  const { t } = useI18n();

  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [term, setTerm] = useState('');

  /*
   * The text a choice put in the box.
   *
   * Picking a suggestion writes its street into the field, which is another
   * change to `value` - and without this the debounce below would treat it as
   * typing and reopen the list on the answer somebody just chose.
   */
  const chosen = useRef<string | null>(null);

  useEffect(() => {
    if (chosen.current === value) return;

    const timer = setTimeout(() => {
      setTerm(value.trim());
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [value]);

  const query = [term, context ?? '']
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(', ');

  const suggestions = useQuery({
    queryKey: ['address-suggest', endpoint, query],
    queryFn: () => api.post<SuggestResponse>(endpoint, { query, limit: 6 }),
    enabled: term.length >= MIN_QUERY,
    /*
     * A geocoder's answer for one address does not go stale, and the same
     * address is typed again every time somebody corrects a field below it.
     * Five minutes of reuse is five minutes of not spending quota.
     */
    staleTime: 5 * 60 * 1000,
    /*
     * One try. A geocoder that did not answer is a normal state here - the
     * field still works - and three retries would only make the failure slower
     * to arrive at.
     */
    retry: false,
  });

  const rows = suggestions.data?.suggestions ?? [];
  const isOpen = open && term.length >= MIN_QUERY;

  const choose = (suggestion: AddressSuggestion): void => {
    chosen.current = suggestion.line1 ?? suggestion.label ?? value;
    setOpen(false);
    setTerm('');
    onPick(suggestion);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      // Closes the list without touching the text. Escape in a combobox means
      // "I do not want these", not "undo what I typed".
      setOpen(false);
      return;
    }

    if (!isOpen || rows.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % rows.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index - 1 + rows.length) % rows.length);
      return;
    }

    if (event.key === 'Enter') {
      const picked = rows[active];
      if (picked === undefined) return;
      // Only when the list is open with something highlighted, so Enter still
      // submits the form the rest of the time.
      event.preventDefault();
      choose(picked);
    }
  };

  return (
    <Field
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      {...(required === true ? { required: true } : {})}
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
            aria-activedescendant={isOpen && rows.length > 0 ? `${listId}-${String(active)}` : undefined}
            autoComplete="off"
            {...(maxLength === undefined ? {} : { maxLength })}
            {...(placeholder === undefined ? {} : { placeholder })}
            value={value}
            onChange={(event) => {
              chosen.current = null;
              setActive(0);
              setOpen(true);
              onChange(event.target.value);
            }}
            onFocus={() => {
              setOpen(true);
            }}
            onBlur={() => {
              /*
               * After the click, not before it.
               *
               * A pointer press on an option blurs the input first, and
               * closing here and now unmounts the row under the finger - the
               * click then lands on whatever the layout collapsed to. The
               * options below also guard this with `onMouseDown`; the delay is
               * the belt to that pair of braces, and covers a touch drag that
               * never fires `mousedown` at all.
               */
              setTimeout(() => {
                setOpen(false);
              }, 150);
            }}
            onKeyDown={onKeyDown}
          />

          {suggestions.isFetching && (
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-subtle">
              <Spinner />
            </span>
          )}

          {isOpen && (rows.length > 0 || !suggestions.isFetching) && (
            <ul
              id={listId}
              role="listbox"
              aria-label={label}
              className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-md border border-border-strong bg-surface py-1 shadow-lg"
            >
              {rows.length === 0 && (
                <li className="px-3 py-2 text-xs text-ink-muted">
                  {suggestions.isError
                    ? t('addressSuggest.failed')
                    : t('addressSuggest.none')}
                </li>
              )}

              {rows.map((row, index) => (
                <li key={`${String(row.latitude)},${String(row.longitude)},${String(index)}`}>
                  <button
                    type="button"
                    id={`${listId}-${String(index)}`}
                    role="option"
                    aria-selected={index === active}
                    className={
                      'block w-full px-3 py-2 text-left text-sm text-ink transition-colors ' +
                      (index === active ? 'bg-surface-sunken' : 'hover:bg-surface-sunken')
                    }
                    onMouseEnter={() => {
                      setActive(index);
                    }}
                    onMouseDown={(event) => {
                      // Keeps the blur above from firing before the click.
                      event.preventDefault();
                    }}
                    onClick={() => {
                      choose(row);
                    }}
                  >
                    <span className="block truncate font-medium">
                      {row.line1 ?? row.label ?? t('addressSuggest.unnamed')}
                    </span>
                    {row.label !== null && (
                      <span className="mt-0.5 block truncate text-xs text-ink-muted">
                        {row.label}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Announced rather than drawn: a sighted person sees the list open,
              and a screen reader is told how many rows arrived. */}
          <span className="sr-only" role="status">
            {isOpen && rows.length > 0
              ? t('addressSuggest.count', { count: rows.length })
              : ''}
          </span>
        </div>
      )}
    </Field>
  );
}
