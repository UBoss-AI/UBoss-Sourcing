import { useEffect, useState } from 'react';

/**
 * A value that settles before anything acts on it.
 *
 * The search box is the reason: a dispatcher typing a shipment reference
 * produces a dozen keystrokes, and a request per keystroke is a dozen queries
 * against the busiest table in the schema for eleven answers nobody reads.
 *
 * 300ms rather than something longer: a search that feels like it is thinking
 * is a search people stop trusting, and this is short enough to be invisible
 * to somebody typing at speed.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delayMs);

    // Cleared on every change, so only the last keystroke in a burst fires.
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return settled;
}
