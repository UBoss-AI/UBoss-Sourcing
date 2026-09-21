/**
 * A QR code, drawn in the browser.
 *
 * The encoding itself is in `lib/qr.ts`; this is only the picture. They are
 * apart because the encoder has a unit test that decodes what it draws, and a
 * module that exports both a component and a function it tests cannot be
 * hot-reloaded in place.
 *
 * WHY IT IS DRAWN HERE RATHER THAN FETCHED
 *
 * The only thing this console ever puts in a QR code is an `otpauth://` URI,
 * and that URI contains the administrator's TOTP SECRET - the entire second
 * factor. A QR image fetched from a chart service would send it to whoever
 * serves that service; one generated on the server would put it in an HTTP
 * response body and in every cache between there and the browser. Neither is
 * acceptable at any price, so the code is drawn from the string, in this
 * process, and the secret never leaves it.
 *
 * The two colours are fixed rather than themed. A scanner reads dark modules
 * on a light field, so a code that followed the console into dark mode would
 * be a code no phone can read.
 */
import { useMemo } from 'react';
import { encodeQr } from '@/lib/qr';

export function QrCode({ value, size = 168 }: { value: string; size?: number }): React.JSX.Element {
  const modules = useMemo(() => {
    try {
      return encodeQr(value);
    } catch {
      return null;
    }
  }, [value]);

  if (modules === null) {
    // The payload could not be encoded. The setup key is printed beside this
    // in plain text, so the person can still type it in - which is why this
    // fails quietly rather than throwing the whole screen away.
    return <div className="h-40 w-40" />;
  }

  const count = modules.length;
  // Four modules of quiet zone on every side, which the specification
  // requires: a code drawn flush to its border is one a scanner cannot find.
  const quiet = 4;
  const total = count + quiet * 2;

  /*
   * One SVG path for every dark module, rather than a rect per module.
   *
   * A version-10 code is 57x57, so a naive render is up to 3,249 DOM nodes on
   * a screen somebody opens once. One path is one node.
   */
  const path = modules
    .flatMap((row, r) =>
      row.map((dark, c) => (dark ? `M${String(c + quiet)} ${String(r + quiet)}h1v1h-1z` : '')),
    )
    .join('');

  return (
    <svg
      viewBox={`0 0 ${String(total)} ${String(total)}`}
      width={size}
      height={size}
      // Decorative: the setup key is printed beside it as text, which is the
      // accessible way to convey it. Announcing a QR code to a screen reader
      // would be announcing something they cannot use.
      role="presentation"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={path} fill="#0b1b34" />
    </svg>
  );
}
