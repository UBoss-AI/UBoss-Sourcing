/**
 * The storefront's icon set.
 *
 * Inline SVG rather than an icon font or a runtime dependency: these are drawn
 * a handful of times per page, and a font request that blocks first paint to
 * deliver twelve glyphs is a poor trade. Inlined, they cost nothing at
 * runtime and are subject to tree shaking.
 *
 * Three rules hold for every icon here:
 *
 *   - **`currentColor`, never a fixed hue.** An icon takes the colour of the
 *     text it sits beside, so it cannot drift out of step with the palette or
 *     fail contrast on a surface it was not drawn for.
 *   - **`aria-hidden`, always.** Every icon in this app sits next to a real
 *     label. An icon that announces itself makes a screen reader read the
 *     same thing twice.
 *   - **One stroke weight (1.7) and one viewBox (24).** Mixed weights are
 *     what makes a row of icons look assembled from three different sets.
 */

interface IconProps {
  className?: string;
}

/** The shared frame. Everything below differs only in its paths. */
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

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

export function SearchIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </Icon>
  );
}

export function CartIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 3h2l.4 2M7 13h10l3-8H5.4M7 13 5.4 5M7 13l-.6 3h12" />
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="17" cy="20" r="1.5" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

// ---------------------------------------------------------------------------
// Operational cues
// ---------------------------------------------------------------------------

export function BriefcaseIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5.5A2.5 2.5 0 0 1 10.5 3h3A2.5 2.5 0 0 1 16 5.5V7" />
      <path d="M3 12.5h18" />
    </Icon>
  );
}

export function TruckIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2.5 6.5h11v10h-11z" />
      <path d="M13.5 10h4l3 3v3.5h-7z" />
      <circle cx="6.75" cy="18.5" r="1.75" />
      <circle cx="16.75" cy="18.5" r="1.75" />
    </Icon>
  );
}

export function RepeatIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m16.5 3 3 3-3 3" />
      <path d="M19.5 6H8.5A4.5 4.5 0 0 0 4 10.5v1" />
      <path d="m7.5 21-3-3 3-3" />
      <path d="M4.5 18h11A4.5 4.5 0 0 0 20 13.5v-1" />
    </Icon>
  );
}

export function ClockIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.2V12l3.4 2" />
    </Icon>
  );
}

export function CurrencyIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M14.8 9.4a3.6 3.6 0 1 0 0 5.2" />
    </Icon>
  );
}

// ---------------------------------------------------------------------------
// Support and small print
// ---------------------------------------------------------------------------

export function MailIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.6 6.6 8.4 5.9 8.4-5.9" />
    </Icon>
  );
}

export function PhoneIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6.6 3h2.7l1.5 3.9-2 1.5a10.4 10.4 0 0 0 4.8 4.8l1.5-2L19 12.7v2.7a2 2 0 0 1-2.2 2A14.8 14.8 0 0 1 4.6 5.2 2 2 0 0 1 6.6 3z" />
    </Icon>
  );
}

export function DocumentIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M13.5 3v5h5.2" />
      <path d="M9 13.5h5M9 17h3.5" />
    </Icon>
  );
}

// ---------------------------------------------------------------------------
// Category placeholders
//
// Deliberately abstract rather than literal — a storefront does not know what
// a category contains, and a wrench beside "Cleaning chemicals" is worse than
// no picture at all. These are geometry: stock shapes that read as "goods"
// without asserting anything about them.
// ---------------------------------------------------------------------------

export function BoxIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m12 2.8 8.6 4.6v9.2L12 21.2l-8.6-4.6V7.4z" />
      <path d="m3.4 7.4 8.6 4.6 8.6-4.6M12 12v9.2" />
    </Icon>
  );
}

export function HexIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m12 2.8 8 4.6v9.2l-8 4.6-8-4.6V7.4z" />
      <circle cx="12" cy="12" r="3.4" />
    </Icon>
  );
}

export function LayersIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m12 2.6 9.4 4.9-9.4 4.9-9.4-4.9z" />
      <path d="m2.6 12.4 9.4 4.9 9.4-4.9" />
      <path d="m2.6 16.6 9.4 4.9 9.4-4.9" />
    </Icon>
  );
}

export function GridIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3.4" y="3.4" width="7.2" height="7.2" rx="1.6" />
      <rect x="13.4" y="3.4" width="7.2" height="7.2" rx="1.6" />
      <rect x="3.4" y="13.4" width="7.2" height="7.2" rx="1.6" />
      <rect x="13.4" y="13.4" width="7.2" height="7.2" rx="1.6" />
    </Icon>
  );
}

export function CylinderIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <ellipse cx="12" cy="6.4" rx="7" ry="3.2" />
      <path d="M5 6.4v11.2c0 1.77 3.13 3.2 7 3.2s7-1.43 7-3.2V6.4" />
    </Icon>
  );
}

export function FlowIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="6.2" cy="6.2" r="2.7" />
      <circle cx="17.8" cy="17.8" r="2.7" />
      <path d="M6.2 8.9v5.6a2.6 2.6 0 0 0 2.6 2.6h6.3" />
      <path d="M8.9 6.2h6.3a2.6 2.6 0 0 1 2.6 2.6v6.3" />
    </Icon>
  );
}

// ---------------------------------------------------------------------------
// Purchase flow
//
// Added for the cart → address → payment → confirmation path. Each of these
// sits next to a real label — the tick beside "Completed", the shield beside
// the payment-provider note — so they carry no meaning on their own and stay
// `aria-hidden` like the rest of the set.
// ---------------------------------------------------------------------------

export function CheckIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

/** A hollow ring with a filled centre: "you are here", without a colour. */
export function DotIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function TrashIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 7h16M10 7V5.2A1.2 1.2 0 0 1 11.2 4h1.6A1.2 1.2 0 0 1 14 5.2V7" />
      <path d="M6.5 7.5 7.3 19a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-11.5" />
      <path d="M10.5 11v6M13.5 11v6" />
    </Icon>
  );
}

export function ShieldIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 3.2 5 5.8v5.4c0 4.3 2.9 8.1 7 9.6 4.1-1.5 7-5.3 7-9.6V5.8z" />
      <path d="m9.2 12.2 2 2 3.6-3.9" />
    </Icon>
  );
}

export function CardIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2.8" y="5.4" width="18.4" height="13.2" rx="2.2" />
      <path d="M2.8 9.8h18.4M6.4 14.6h3.4" />
    </Icon>
  );
}

export function LinkIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M10.6 13.4a3.6 3.6 0 0 0 5.4.4l2.4-2.4a3.6 3.6 0 0 0-5.1-5.1l-1.4 1.4" />
      <path d="M13.4 10.6a3.6 3.6 0 0 0-5.4-.4l-2.4 2.4a3.6 3.6 0 0 0 5.1 5.1l1.4-1.4" />
    </Icon>
  );
}

export function LocationIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 21c4-4.2 6-7.5 6-10a6 6 0 1 0-12 0c0 2.5 2 5.8 6 10z" />
      <circle cx="12" cy="11" r="2.4" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.8v5M12 16.1h.01" />
    </Icon>
  );
}
