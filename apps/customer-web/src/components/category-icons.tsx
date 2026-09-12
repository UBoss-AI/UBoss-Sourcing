/**
 * Category marks for a medical consumables catalogue.
 *
 * `icons.tsx` carries six abstract stock shapes for category cards, and the
 * reasoning written beside them is sound in general: a storefront does not
 * know what a category contains, and a wrench beside "Cleaning chemicals" is
 * worse than no picture at all.
 *
 * That reasoning stops applying the moment the catalogue is one trade and the
 * departments are named things like "IV Cannula" and "Ryles Tube". A cannula
 * drawn beside "IV Cannula" cannot be wrong about what is in it, and a
 * hospital buyer scanning twenty-two departments finds the one they came for
 * by shape long before they finish reading the labels.
 *
 * So this is a **recognised-name** set, not a replacement: `categoryMark` in
 * HomePage matches a department to a mark here and falls back to the abstract
 * geometry when nothing matches. A category somebody adds next year gets the
 * old behaviour, which is the right behaviour for a name this file has never
 * seen.
 *
 * The three rules from `icons.tsx` hold here too - `currentColor`, always
 * `aria-hidden`, one stroke weight and one viewBox - because a row that mixed
 * two icon sets would look assembled rather than drawn.
 *
 * They are drawn rather than downloaded. A stroke icon at 24px scales to any
 * size, takes the theme's colour in both light and dark, costs no request, and
 * carries no licence - none of which is true of a PNG off an icon site. It
 * also means each one can be drawn for the actual product: an ENFit syringe
 * really does have a different tip from an oral one, and that difference is
 * the whole reason the two departments are separate.
 */

interface IconProps {
  className?: string;
}

/** The same frame `icons.tsx` uses, so the two sets sit together. */
function Icon({
  className = 'h-5 w-5',
  children,
}: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export type CategoryMark = (props: IconProps) => React.JSX.Element;

// ---------------------------------------------------------------------------
// Syringes
//
// Four of them, because four departments here are syringes and a single glyph
// repeated four times would tell a buyer nothing about which is which. The
// barrel and plunger are common; the tip is what differs, which is exactly
// what differs on the shelf.
// ---------------------------------------------------------------------------

/** A hypodermic syringe: barrel, graduations, plunger, needle. */
export function SyringeIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4.2 19.8 7 17" />
      <path d="m7.6 16.4 6-6 4 4-6 6a1.4 1.4 0 0 1-2 0l-2-2a1.4 1.4 0 0 1 0-2Z" />
      <path d="m13.2 8.2 2.6-2.6 4 4-2.6 2.6" />
      <path d="m16.6 3.4 4 4" />
      <path d="m11.2 12.4 1.6 1.6M13.2 10.4l1.6 1.6" />
    </Icon>
  );
}

/**
 * An oral dosing syringe: the same barrel with a plain tip and no needle.
 *
 * The absence of the needle is the point - it is what makes the department a
 * different department, and what stops somebody drawing up an oral dose into
 * something that can be injected.
 */
export function OralSyringeIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="5" y="8.4" width="12" height="7.2" rx="1.2" />
      <path d="M17 10.6h2.6a1 1 0 0 1 1 1v.8a1 1 0 0 1-1 1H17" />
      <path d="M5 12H1.8M3.4 9.6v4.8" />
      <path d="M8.6 8.4v7.2M11.4 8.4v7.2M14.2 8.4v7.2" />
    </Icon>
  );
}

/**
 * An ENFit enteral syringe: the barrel with a collared screw tip.
 *
 * ENFit is a deliberately incompatible connector - the whole safety case for
 * it is that an enteral line cannot be joined to an intravenous one - so the
 * collar is drawn rather than implied.
 */
export function EnteralSyringeIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="4.4" y="8.4" width="11" height="7.2" rx="1.2" />
      <path d="M15.4 9.8h2.2v4.4h-2.2" />
      <path d="M17.6 10.8h2.8v2.4h-2.8" />
      <path d="M20.4 11.2h1.6v1.6h-1.6" />
      <path d="M4.4 12H1.6M3 9.6v4.8" />
      <path d="M8 8.4v7.2M11.4 8.4v7.2" />
    </Icon>
  );
}

/**
 * A prefilled flush syringe: a filled barrel with a screw cap.
 *
 * The fill is what separates it from an empty syringe on a shelf, and a flush
 * syringe is bought precisely because it arrives full.
 */
export function PrefilledSyringeIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="6.4" y="7" width="7.2" height="12" rx="1.2" />
      <path d="M6.4 11.2h7.2v6.6a1.2 1.2 0 0 1-1.2 1.2H7.6a1.2 1.2 0 0 1-1.2-1.2Z" />
      <path d="M10 7V4.6M8.2 4.6h3.6a.9.9 0 0 1 .9.9v.6a.9.9 0 0 1-.9.9H8.2a.9.9 0 0 1-.9-.9v-.6a.9.9 0 0 1 .9-.9Z" />
      <path d="M13.6 9.4h1.8M13.6 12.4h1.8M13.6 15.4h1.8" />
    </Icon>
  );
}

// ---------------------------------------------------------------------------
// Intravenous access
// ---------------------------------------------------------------------------

/** An IV cannula: winged hub, injection port, catheter. */
export function CannulaIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m3 14.6 5.4-5.4" />
      <path d="M9 8.6h5.2a1.4 1.4 0 0 1 1.4 1.4v4a1.4 1.4 0 0 1-1.4 1.4H9a1.4 1.4 0 0 1-1.4-1.4v-4A1.4 1.4 0 0 1 9 8.6Z" />
      <path d="M8.8 8.6 6.6 5.8a.9.9 0 0 1 .8-1.4h2.2a.9.9 0 0 1 .8 1.4L9.4 8.6" />
      <path d="M15.6 10.8h3.2a1.2 1.2 0 0 1 1.2 1.2v.4a1.2 1.2 0 0 1-1.2 1.2h-3.2" />
      <path d="M20 12.2h2.2" />
    </Icon>
  );
}

/**
 * A closed-system cannula: the same hub with a valve and an extension line.
 *
 * The closed loop is the product. An open cannula and a closed one are the
 * same picture without it.
 */
export function ClosedCannulaIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6.4 6.2h5a1.3 1.3 0 0 1 1.3 1.3v3a1.3 1.3 0 0 1-1.3 1.3h-5A1.3 1.3 0 0 1 5.1 10.5v-3A1.3 1.3 0 0 1 6.4 6.2Z" />
      <path d="M5.1 8.8 2.4 8.8" />
      <path d="M12.7 9c2.6 0 4.3 1.4 4.3 3.6 0 2.6-2.6 3.4-2.6 5.4a2.4 2.4 0 0 0 2.4 2.4h1.6" />
      <circle cx="20.2" cy="20.4" r="1.6" />
      <path d="M8.9 6.2V4M7.2 4h3.4" />
    </Icon>
  );
}

/** An infusion set: spike, drip chamber, roller clamp, line. */
export function InfusionSetIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M11.4 2.2v2" />
      <path d="M8.8 4.2h5.2l-1 2.2H9.8Z" />
      <path d="M9.6 6.4h3.6v5.2a1.8 1.8 0 0 1-1.8 1.8 1.8 1.8 0 0 1-1.8-1.8Z" />
      <circle cx="11.4" cy="9.2" r=".9" />
      <path d="M11.4 13.4v3.2c0 2.6 2.4 2.4 2.4 4.6" />
      <rect x="9.6" y="16.2" width="3.6" height="2.6" rx=".8" />
    </Icon>
  );
}

/** A safety needle: the needle with its hinged guard raised over the shaft. */
export function SafetyNeedleIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m3.4 20.6 3-3" />
      <path d="M7.2 16.8h3.4a1.2 1.2 0 0 1 1.2 1.2v.6a1.2 1.2 0 0 1-1.2 1.2H7.2Z" transform="rotate(-45 9.4 18.3)" />
      <path d="m11.4 12.6 6.2-6.2" />
      <path d="M15.4 4.2 19.8 8.6" />
      <path d="m13.8 10.2 2.6-8a.9.9 0 0 1 1.6-.2l1.8 2.4" />
    </Icon>
  );
}

/** A disinfection cap: a small cap over a connector hub. */
export function DisinfectantCapIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 13.6h6v5.2a1.4 1.4 0 0 1-1.4 1.4h-3.2A1.4 1.4 0 0 1 9 18.8Z" />
      <path d="M8.2 11.4h7.6v2.2H8.2Z" />
      <path d="M10.6 11.4V8.2M13.4 11.4V8.2" />
      <path d="M9.4 8.2h5.2" />
      <path d="M17.8 5.4c.8.9 1.2 1.7 1.2 2.4a1.7 1.7 0 0 1-3.4 0c0-.7.4-1.5 1.2-2.4l.5-.6Z" />
    </Icon>
  );
}

// ---------------------------------------------------------------------------
// Tubes and catheters
// ---------------------------------------------------------------------------

/** A suction catheter: a funnel connector with a vent and a long tube. */
export function SuctionCatheterIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M7.6 3.2h5.6l-1.2 3.4H8.8Z" />
      <circle cx="10.4" cy="4.6" r=".8" />
      <path d="M10.4 6.6c0 3.4 4.6 3.8 4.6 7.4 0 3.2-3.4 3.6-3.4 6.6" />
      <path d="M11.6 20.6h-1.2" />
      <path d="M14.3 12.2h.1M14.9 14.6h.1" />
    </Icon>
  );
}

/** A Ryles tube: a graduated nasogastric tube with a funnel end. */
export function RylesTubeIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 3.4h5.6l-1.4 3H9.4Z" />
      <path d="M10.8 6.4c0 4 5 4.4 5 8.4 0 3.4-4 4-4 7" />
      <path d="M13.4 10.4h.1M15.4 13h.1M15.2 16.2h.1M13.6 19h.1" />
      <path d="M10.6 21.8h1.8" />
    </Icon>
  );
}

/** An infant feeding tube: the same shape, smaller, with a marked tip. */
export function FeedingTubeIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8.6 4.4h4.6l-1.2 2.6H9.8Z" />
      <path d="M11 7c0 3.2 3.8 3.6 3.8 6.6 0 2.8-2.8 3.2-2.8 5.8" />
      <circle cx="12" cy="20.4" r="1.2" />
      <path d="M13.6 11h.1M14.6 13.8h.1" />
    </Icon>
  );
}

/** An extension / line-access set: a Y-connector on a line. */
export function LineAccessIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3.4 12h4.2" />
      <path d="M7.6 9.8h3.2v4.4H7.6Z" />
      <path d="M10.8 12h2.4l3.4-3.4" />
      <path d="M13.2 12h.2l3.4 3.4" />
      <circle cx="17.6" cy="7.6" r="1.6" />
      <circle cx="17.6" cy="16.4" r="1.6" />
    </Icon>
  );
}

// ---------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------

/** A surgical glove. */
export function GloveIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M7 21V11.2" />
      <path d="M7 12.4V6.6a1.3 1.3 0 0 1 2.6 0v4" />
      <path d="M9.6 10.6V4.4a1.3 1.3 0 0 1 2.6 0v6" />
      <path d="M12.2 10.6V5.6a1.3 1.3 0 0 1 2.6 0v5.4" />
      <path d="M14.8 11.2V8a1.3 1.3 0 0 1 2.6 0v6.6c0 3.6-1.6 6.4-1.6 6.4" />
      <path d="M7 12.4a2.6 2.6 0 0 0-2.6 2.6c0 1.4.8 2.2 2.6 3.4" />
      <path d="M7 21h8.8" />
    </Icon>
  );
}

/**
 * An adult incontinence pad.
 *
 * The hourglass outline is the whole icon: wide at the waist, drawn in at the
 * middle, wide again at the back. An earlier attempt used a shield with lines
 * across it and read as a face — which is the trouble with drawing this
 * particular product abstractly, and the reason it is drawn literally here.
 *
 * The two short marks at the top are the fastening tapes, and the pair in the
 * middle are the absorbent core. Both are what separates it from any other
 * hourglass at 28 pixels.
 */
export function DiaperIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4.8 4.4h14.4c0 0-2.6 2.9-2.6 7.6s2.6 7.6 2.6 7.6H4.8c0 0 2.6-2.9 2.6-7.6S4.8 4.4 4.8 4.4Z" />
      <path d="M4.8 6.6h2.2M17 6.6h2.2" />
      <path d="M10.4 10.2h3.2M10.4 13.8h3.2" />
    </Icon>
  );
}

/** An arterial blood-gas syringe: a syringe barrel with a drop. */
export function BloodGasSyringeIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="5.4" y="7.2" width="6.8" height="11.4" rx="1.2" />
      <path d="M5.4 11h6.8v6.4a1.2 1.2 0 0 1-1.2 1.2H6.6a1.2 1.2 0 0 1-1.2-1.2Z" />
      <path d="M8.8 7.2V4.8M7 4.8h3.6" />
      <path d="M17.6 8.4c1.3 1.6 2 2.9 2 4a2 2 0 0 1-4 0c0-1.1.7-2.4 2-4Z" />
    </Icon>
  );
}

/** A sampling kit: a case with its contents. */
export function SamplingKitIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3" y="7.4" width="18" height="12" rx="1.6" />
      <path d="M9 7.4V5.6a1.2 1.2 0 0 1 1.2-1.2h3.6A1.2 1.2 0 0 1 15 5.6v1.8" />
      <path d="M3 12.4h18" />
      <path d="M10.2 15.6h3.6" />
    </Icon>
  );
}

/** A vial of sterile water: a bottle with a drop. */
export function SterileWaterIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9.6 2.8h4.8v2.4l1.8 2.6a3 3 0 0 1 .5 1.7v9.1a2.4 2.4 0 0 1-2.4 2.4H9.7a2.4 2.4 0 0 1-2.4-2.4V9.5a3 3 0 0 1 .5-1.7l1.8-2.6Z" />
      <path d="M9.6 5.2h4.8" />
      <path d="M12 11.4c1.2 1.5 1.8 2.7 1.8 3.6a1.8 1.8 0 0 1-3.6 0c0-.9.6-2.1 1.8-3.6Z" />
    </Icon>
  );
}

/** Sterile water with glycerine: the same vial, marked with a percentage. */
export function GlycerineIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 2.8h4.6v2.3l1.7 2.5a2.9 2.9 0 0 1 .5 1.6v8.7a2.3 2.3 0 0 1-2.3 2.3H9.1a2.3 2.3 0 0 1-2.3-2.3V9.2a2.9 2.9 0 0 1 .5-1.6l1.7-2.5Z" />
      <path d="M9 5.1h4.6" />
      <circle cx="10" cy="12.4" r="1.1" />
      <circle cx="13" cy="15.8" r="1.1" />
      <path d="m13.8 11.6-4.4 5.6" />
    </Icon>
  );
}
