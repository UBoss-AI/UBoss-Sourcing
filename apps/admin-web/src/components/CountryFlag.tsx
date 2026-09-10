/**
 * A country's flag, drawn.
 *
 * Byte-for-byte the same file as apps/customer-web/src/components/CountryFlag.tsx,
 * and deliberately so — the same rule the `ui.tsx` and `icons.tsx` pairs
 * follow. A flag that differs between the storefront and the panel is one
 * country drawn two ways in one product, so a correction goes in both files or
 * it has not really been made.
 *
 * Three approaches were possible and two of them are wrong for this product.
 *
 * **Not emoji.** `🇮🇳` is two regional-indicator code points that a font is
 * expected to compose into a flag, and Windows ships no font that does — every
 * browser on it except Firefox renders the pair as the letters "IN" in two
 * boxes. Since this control is in the header of every page, on the platform
 * the operator is most likely to be running, "the flag is sometimes two
 * letters in a box" is not a rendering detail, it is the design.
 *
 * **Not images.** UBOSS is self-hosted, and the greeting page's rule applies
 * to the chrome as well: it has to look finished with nothing supplied. A
 * sprite sheet is 43 requests or one large one, a CDN is a third party in the
 * page, and either can 404 on a deployment behind a firewall. Nothing in this
 * app's chrome depends on a file arriving.
 *
 * **So they are drawn here, and they are stylised.** Each flag is a handful of
 * bands plus, where a flag needs one, a single mark. At 20×14 CSS pixels — the
 * size this actually renders — a stylised flag and an exact one are the same
 * picture, and an exact one would be several kilobytes of path data per
 * country for detail no display can resolve. What matters at this size is that
 * the right flag is recognisable at a glance, which bands and one mark
 * achieve.
 *
 * A country with no entry in the table falls back to its two-letter code in a
 * tinted plate. That is not a failure state: `Country` is a database table an
 * operator can add rows to, so an unknown code is an ordinary event, and a
 * deliberate letter chip reads as a design decision where a blank box or a
 * question mark would read as a bug.
 *
 * The flag is always `aria-hidden`. Every place it appears, the country's own
 * name is beside it in text — a screen reader hearing "flag of India, India"
 * has been told the same thing twice.
 */
import { cx } from '@/lib/cx';

// ---------------------------------------------------------------------------
// Palette
//
// Named rather than repeated, because a dozen flags share the same red and a
// dozen more the same blue, and one list is what stops the set drifting into
// fourteen slightly different scarlets.
// ---------------------------------------------------------------------------

const C = {
  white: '#FFFFFF',
  black: '#1A1A1A',
  red: '#D62B2B',
  deepRed: '#B31942',
  maroon: '#8D1B3D',
  crimson: '#C8102E',
  blue: '#1D4ED8',
  navy: '#10275C',
  sky: '#3B9FE0',
  green: '#118A4E',
  darkGreen: '#0B5C38',
  yellow: '#F5CF2E',
  gold: '#E8B923',
  orange: '#E8862A',
  saffron: '#F09019',
  chakra: '#1D3F94',
  copper: '#C9722E',
} as const;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The drawing grid. 3:2, which is the ratio most of these flags are flown at. */
const W = 24;
const H = 16;

type Mark =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill?: string; stroke?: string }
  | { kind: 'path'; d: string; fill?: string; stroke?: string; width?: number };

interface Flag {
  /** Equal bands, top to bottom (`h`) or left to right (`v`). */
  bands: 'h' | 'v';
  colors: readonly string[];
  /** Anything the bands cannot say. At most a couple per flag. */
  marks?: readonly Mark[];
}

/** A single-colour ground, expressed as one band. */
function plain(colour: string, marks?: readonly Mark[]): Flag {
  return marks === undefined
    ? { bands: 'h', colors: [colour] }
    : { bands: 'h', colors: [colour], marks };
}

/** A Nordic cross: an upright offset left of centre, and a full crossbar. */
function nordicCross(colour: string, inner?: string): readonly Mark[] {
  const arms: Mark[] = [
    { kind: 'rect', x: 7, y: 0, w: 4, h: H, fill: colour },
    { kind: 'rect', x: 0, y: 6, w: W, h: 4, fill: colour },
  ];

  if (inner === undefined) return arms;

  return [
    ...arms,
    { kind: 'rect', x: 8.2, y: 0, w: 1.6, h: H, fill: inner },
    { kind: 'rect', x: 0, y: 7.2, w: W, h: 1.6, fill: inner },
  ];
}

/** A centred cross, the Swiss and Greek arrangement. */
function centredCross(colour: string, thickness = 3.4): readonly Mark[] {
  return [
    { kind: 'rect', x: (W - thickness) / 2, y: 3, w: thickness, h: H - 6, fill: colour },
    { kind: 'rect', x: 6, y: (H - thickness) / 2, w: W - 12, h: thickness, fill: colour },
  ];
}

/**
 * Every market this ships with a drawing for.
 *
 * The EU-27 come first because they are the bulk of them and they are almost
 * all two or three bands, which is the whole reason this table is short enough
 * to be worth having. The rest follow in the order `reference-data.ts` seeds
 * them.
 */
const FLAGS: Readonly<Record<string, Flag>> = {
  // --- European Union ------------------------------------------------------
  AT: { bands: 'h', colors: [C.red, C.white, C.red] },
  BE: { bands: 'v', colors: [C.black, C.yellow, C.red] },
  BG: { bands: 'h', colors: [C.white, C.green, C.red] },
  HR: {
    bands: 'h',
    colors: [C.red, C.white, C.blue],
    // The chequy shield, as one small square. The real one is thirteen; at
    // this size thirteen is a grey smudge and one reads as a crest.
    marks: [{ kind: 'rect', x: 10.6, y: 5.2, w: 2.8, h: 3, fill: C.red }],
  },
  CY: plain(C.white, [
    { kind: 'path', d: 'M8.6 5.4h6.4l1.4 2.6-2.6 2.4-4-.6-2.4-1.8Z', fill: C.copper },
    { kind: 'path', d: 'M9 12.4h2.6M12.8 12.4h2.2', stroke: C.darkGreen, width: 0.9 },
  ]),
  CZ: {
    bands: 'h',
    colors: [C.white, C.red],
    marks: [{ kind: 'path', d: `M0 0 12 ${H / 2} 0 ${H}Z`, fill: C.navy }],
  },
  DK: plain(C.crimson, nordicCross(C.white)),
  EE: { bands: 'h', colors: [C.sky, C.black, C.white] },
  FI: plain(C.white, nordicCross(C.navy)),
  FR: { bands: 'v', colors: [C.blue, C.white, C.red] },
  DE: { bands: 'h', colors: [C.black, C.red, C.gold] },
  GR: {
    bands: 'h',
    // Nine stripes, and they have to be nine: five and four is the flag, and
    // a simplified three-stripe version reads as Argentina.
    colors: [C.blue, C.white, C.blue, C.white, C.blue, C.white, C.blue, C.white, C.blue],
    marks: [
      { kind: 'rect', x: 0, y: 0, w: 9, h: 9, fill: C.blue },
      { kind: 'rect', x: 3.6, y: 0, w: 1.8, h: 9, fill: C.white },
      { kind: 'rect', x: 0, y: 3.6, w: 9, h: 1.8, fill: C.white },
    ],
  },
  HU: { bands: 'h', colors: [C.red, C.white, C.green] },
  IE: { bands: 'v', colors: [C.green, C.white, C.orange] },
  IT: { bands: 'v', colors: [C.green, C.white, C.red] },
  LV: {
    bands: 'h',
    colors: [C.maroon, C.white, C.maroon],
    // The white band is half the height of the others, which is the one thing
    // that distinguishes this from Austria at a glance.
    marks: [
      { kind: 'rect', x: 0, y: 5.33, w: W, h: 5.34, fill: C.maroon },
      { kind: 'rect', x: 0, y: 6.6, w: W, h: 2.8, fill: C.white },
    ],
  },
  LT: { bands: 'h', colors: [C.yellow, C.green, C.red] },
  LU: { bands: 'h', colors: [C.red, C.white, C.sky] },
  MT: { bands: 'v', colors: [C.white, C.crimson] },
  NL: { bands: 'h', colors: [C.red, C.white, C.blue] },
  PL: { bands: 'h', colors: [C.white, C.crimson] },
  PT: {
    bands: 'v',
    colors: [C.darkGreen, C.darkGreen, C.red, C.red, C.red],
    marks: [{ kind: 'circle', cx: 9.6, cy: 8, r: 2.6, fill: C.yellow, stroke: C.white }],
  },
  RO: { bands: 'v', colors: [C.navy, C.yellow, C.red] },
  SK: {
    bands: 'h',
    colors: [C.white, C.blue, C.red],
    marks: [{ kind: 'path', d: 'M8.6 4.6h5v4.2l-2.5 2.6-2.5-2.6Z', fill: C.crimson }],
  },
  SI: {
    bands: 'h',
    colors: [C.white, C.blue, C.red],
    marks: [{ kind: 'path', d: 'M4.4 3.4h4.6v4l-2.3 2.4-2.3-2.4Z', fill: C.navy }],
  },
  ES: {
    bands: 'h',
    colors: [C.crimson, C.gold, C.crimson],
    // The gold band is half the flag, not a third.
    marks: [{ kind: 'rect', x: 0, y: 4, w: W, h: 8, fill: C.gold }],
  },
  SE: plain(C.blue, nordicCross(C.yellow)),

  // --- Everywhere else -----------------------------------------------------
  IN: {
    bands: 'h',
    colors: [C.saffron, C.white, C.green],
    marks: [{ kind: 'circle', cx: 12, cy: 8, r: 2.1, stroke: C.chakra }],
  },
  AE: {
    bands: 'h',
    colors: [C.green, C.white, C.black],
    marks: [{ kind: 'rect', x: 0, y: 0, w: 6, h: H, fill: C.crimson }],
  },
  AU: plain(C.navy, [
    { kind: 'rect', x: 0, y: 0, w: 11, h: 8, fill: C.blue },
    { kind: 'rect', x: 4.6, y: 0, w: 1.8, h: 8, fill: C.white },
    { kind: 'rect', x: 0, y: 3.1, w: 11, h: 1.8, fill: C.white },
    { kind: 'circle', cx: 5.5, cy: 12.4, r: 1.1, fill: C.white },
    { kind: 'circle', cx: 17.4, cy: 5.6, r: 0.9, fill: C.white },
    { kind: 'circle', cx: 19, cy: 10.4, r: 0.9, fill: C.white },
  ]),
  CA: {
    bands: 'v',
    colors: [C.crimson, C.white, C.crimson],
    marks: [
      {
        kind: 'path',
        d: 'M12 3.6l1 2.6 2.1-.9-1 2.5 1.6.7-1.7 1.3.4 1.3-2-.5v2.1h-.8v-2.1l-2 .5.4-1.3-1.7-1.3 1.6-.7-1-2.5 2.1.9Z',
        fill: C.crimson,
      },
    ],
  },
  CH: plain(C.crimson, centredCross(C.white)),
  GB: plain(C.navy, [
    // The saltire, then the cross of St George over it. Two diagonals as
    // strokes rather than clipped quadrilaterals: at this size the counter-
    // change nobody can see is not worth the geometry.
    { kind: 'path', d: `M0 0 ${W} ${H}M${W} 0 0 ${H}`, stroke: C.white, width: 3.4 },
    { kind: 'path', d: `M0 0 ${W} ${H}M${W} 0 0 ${H}`, stroke: C.crimson, width: 1.6 },
    { kind: 'rect', x: 9.6, y: 0, w: 4.8, h: H, fill: C.white },
    { kind: 'rect', x: 0, y: 5.6, w: W, h: 4.8, fill: C.white },
    { kind: 'rect', x: 10.6, y: 0, w: 2.8, h: H, fill: C.crimson },
    { kind: 'rect', x: 0, y: 6.6, w: W, h: 2.8, fill: C.crimson },
  ]),
  JP: plain(C.white, [{ kind: 'circle', cx: 12, cy: 8, r: 4.2, fill: C.deepRed }]),
  KR: plain(C.white, [
    { kind: 'circle', cx: 12, cy: 8, r: 3.4, fill: C.crimson },
    { kind: 'path', d: 'M8.6 8a3.4 3.4 0 0 1 6.8 0 1.7 1.7 0 0 0-3.4 0 1.7 1.7 0 0 1-3.4 0Z', fill: C.navy },
    { kind: 'path', d: 'M3 4.4h2.6M3 11.6h2.6M18.4 4.4H21M18.4 11.6H21', stroke: C.black, width: 0.8 },
  ]),
  MY: {
    bands: 'h',
    colors: [
      C.crimson,
      C.white,
      C.crimson,
      C.white,
      C.crimson,
      C.white,
      C.crimson,
      C.white,
    ],
    marks: [
      { kind: 'rect', x: 0, y: 0, w: 12, h: 9, fill: C.navy },
      { kind: 'circle', cx: 5, cy: 4.6, r: 2.4, fill: C.yellow },
      { kind: 'circle', cx: 6.4, cy: 4.6, r: 2.1, fill: C.navy },
    ],
  },
  NO: plain(C.crimson, nordicCross(C.white, C.navy)),
  NZ: plain(C.navy, [
    { kind: 'rect', x: 0, y: 0, w: 11, h: 8, fill: C.blue },
    { kind: 'rect', x: 4.6, y: 0, w: 1.8, h: 8, fill: C.white },
    { kind: 'rect', x: 0, y: 3.1, w: 11, h: 1.8, fill: C.white },
    { kind: 'circle', cx: 16.4, cy: 5, r: 0.9, fill: C.crimson },
    { kind: 'circle', cx: 19.4, cy: 8, r: 0.9, fill: C.crimson },
    { kind: 'circle', cx: 16.4, cy: 11, r: 0.9, fill: C.crimson },
  ]),
  OM: {
    bands: 'h',
    colors: [C.white, C.crimson, C.green],
    marks: [{ kind: 'rect', x: 0, y: 0, w: 6, h: H, fill: C.crimson }],
  },
  QA: {
    bands: 'v',
    colors: [C.white, C.maroon, C.maroon, C.maroon],
    // The nine-point serration, drawn as one zigzag seam.
    marks: [
      {
        kind: 'path',
        d: 'M6 0l2.4 1.8L6 3.6l2.4 1.8L6 7.2l2.4 1.8L6 10.8l2.4 1.8L6 14.4l2.4 1.6H6Z',
        fill: C.white,
      },
    ],
  },
  SA: plain(C.darkGreen, [
    { kind: 'path', d: 'M5 6.4h14', stroke: C.white, width: 1.1 },
    { kind: 'path', d: 'M6.4 10.4h11.2', stroke: C.white, width: 1.6 },
  ]),
  SG: {
    bands: 'h',
    colors: [C.crimson, C.white],
    marks: [
      { kind: 'circle', cx: 5.6, cy: 4, r: 2.4, fill: C.white },
      { kind: 'circle', cx: 7.2, cy: 4, r: 2.2, fill: C.crimson },
      { kind: 'circle', cx: 9.4, cy: 2.6, r: 0.55, fill: C.white },
      { kind: 'circle', cx: 9.4, cy: 5.4, r: 0.55, fill: C.white },
      { kind: 'circle', cx: 10.8, cy: 4, r: 0.55, fill: C.white },
    ],
  },
  US: {
    bands: 'h',
    colors: [
      C.deepRed,
      C.white,
      C.deepRed,
      C.white,
      C.deepRed,
      C.white,
      C.deepRed,
      C.white,
      C.deepRed,
      C.white,
      C.deepRed,
      C.white,
      C.deepRed,
    ],
    marks: [
      { kind: 'rect', x: 0, y: 0, w: 10, h: 8.6, fill: C.navy },
      { kind: 'circle', cx: 2.6, cy: 2.4, r: 0.55, fill: C.white },
      { kind: 'circle', cx: 5, cy: 2.4, r: 0.55, fill: C.white },
      { kind: 'circle', cx: 7.4, cy: 2.4, r: 0.55, fill: C.white },
      { kind: 'circle', cx: 3.8, cy: 4.3, r: 0.55, fill: C.white },
      { kind: 'circle', cx: 6.2, cy: 4.3, r: 0.55, fill: C.white },
      { kind: 'circle', cx: 2.6, cy: 6.2, r: 0.55, fill: C.white },
      { kind: 'circle', cx: 5, cy: 6.2, r: 0.55, fill: C.white },
      { kind: 'circle', cx: 7.4, cy: 6.2, r: 0.55, fill: C.white },
    ],
  },
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function bandRects(flag: Flag): React.JSX.Element[] {
  const count = flag.colors.length;

  return flag.colors.map((colour, index) => {
    const span = flag.bands === 'h' ? H / count : W / count;

    return flag.bands === 'h' ? (
      <rect key={index} x={0} y={index * span} width={W} height={span + 0.02} fill={colour} />
    ) : (
      <rect key={index} x={index * span} y={0} width={span + 0.02} height={H} fill={colour} />
    );
  });
}

function markElement(mark: Mark, index: number): React.JSX.Element {
  if (mark.kind === 'rect') {
    return <rect key={index} x={mark.x} y={mark.y} width={mark.w} height={mark.h} fill={mark.fill} />;
  }

  if (mark.kind === 'circle') {
    return (
      <circle
        key={index}
        cx={mark.cx}
        cy={mark.cy}
        r={mark.r}
        fill={mark.fill ?? 'none'}
        stroke={mark.stroke ?? 'none'}
        strokeWidth={mark.stroke === undefined ? undefined : 0.8}
      />
    );
  }

  return (
    <path
      key={index}
      d={mark.d}
      fill={mark.fill ?? 'none'}
      stroke={mark.stroke ?? 'none'}
      strokeWidth={mark.width ?? 1}
    />
  );
}

export interface CountryFlagProps {
  /** ISO-3166-1 alpha-2. Case is not significant. */
  code: string;
  className?: string;
}

/**
 * The flag, or the code in a plate when there is no drawing for it.
 *
 * `rounded-sm` with an inset hairline, always: several of these are mostly
 * white, and a white rectangle on a white header with no edge is not a flag,
 * it is a gap. The ring is `black/10` rather than a palette border so it works
 * over any of the colours above.
 */
export function CountryFlag({ code, className }: CountryFlagProps): React.JSX.Element {
  const normalised = code.trim().toUpperCase();
  const flag = FLAGS[normalised];

  // `h-4 w-6` is 16×24, which is the viewBox's own 3:2. Sized anywhere else
  // the drawing is stretched rather than letterboxed — see the note on
  // `preserveAspectRatio` below.
  const shell = cx(
    'inline-block shrink-0 overflow-hidden rounded-sm ring-1 ring-inset ring-ink/15',
    className ?? 'h-4 w-6',
  );

  if (flag === undefined) {
    return (
      <span
        aria-hidden="true"
        className={cx(
          shell,
          'bg-brand-soft text-center align-middle text-[0.5rem] font-bold leading-4 tracking-tight text-brand',
        )}
      >
        {normalised.slice(0, 2)}
      </span>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={shell}
      // `none`, deliberately. The default would letterbox, and a flag with
      // white bars above and below it is not a flag — it is a flag that looks
      // like it failed to load. Every caller sizes this at or near 3:2, so the
      // stretch is a percent or two, which is invisible even on the discs.
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {bandRects(flag)}
      {(flag.marks ?? []).map(markElement)}
    </svg>
  );
}
