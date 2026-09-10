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

/**
 * A phone with an arrow leaving it — paying from a handset.
 *
 * Deliberately generic rather than UPI's own mark. A payment network's logo is
 * its trademark and comes with usage rules an operator would have to accept on
 * their own behalf; a shape that reads as "pay from your phone" says the same
 * thing beside a label that already reads "Pay with UPI", and it stays correct
 * if a deployment's gateway offers a different wallet later.
 */
export function UpiIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="5.4" y="2.6" width="10.2" height="18.8" rx="2.2" />
      <path d="M10.2 18.4h1" />
      <path d="M14.6 9.6h5.2m0 0-1.9-1.9m1.9 1.9-1.9 1.9" />
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

// ---------------------------------------------------------------------------
// The sourcing hub
//
// Added for the greeting page's orchestration graphic, where each node is a
// capability rather than a control. They follow the same rules as the rest of
// the set — `currentColor`, `aria-hidden`, stroke 1.7 — because a node's name
// is always rendered as text beside its mark, never replaced by it.
// ---------------------------------------------------------------------------

/** The assistant. A spark rather than a speech bubble: what it does is think. */
export function SparkIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M11 3.6 12.7 8.6 17.7 10.3 12.7 12 11 17 9.3 12 4.3 10.3 9.3 8.6z" />
      <path d="M17.6 15.2v3.4M15.9 16.9h3.4" />
    </Icon>
  );
}

/** A month, for a delivery that has a date rather than a queue position. */
export function CalendarIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3.2" y="5.2" width="17.6" height="15.6" rx="2.2" />
      <path d="M3.2 10h17.6M8.2 3.2v4M15.8 3.2v4" />
    </Icon>
  );
}

/** Dismiss. Shared, so a close button is the same cross wherever it appears. */
export function CloseIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  );
}

// ---------------------------------------------------------------------------
// Search, voice and AI Mode
//
// Added for the hero search module and the AI Mode page. Same three rules as
// everything above — `currentColor`, `aria-hidden`, one stroke weight — which
// matters more here than usual: these sit inside a single search bar, at the
// same size, a few pixels apart, where any drift in weight is obvious.
// ---------------------------------------------------------------------------

/** Dictate instead of typing. A capsule on a stand, not a stage microphone. */
export function MicIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="9" y="2.8" width="6" height="11.4" rx="3" />
      <path d="M5.5 11.2a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.7V21M9 21h6" />
    </Icon>
  );
}

/** Search by photograph. A camera body, so it cannot be read as "attach file". */
export function CameraIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 8.6a2 2 0 0 1 2-2h2.3l1.3-2.1h6.8l1.3 2.1H19a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="12.8" r="3.6" />
    </Icon>
  );
}

/** Attach something to a message. */
export function PaperclipIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M20.4 11.6 12 20a5.2 5.2 0 0 1-7.4-7.4l8.5-8.5a3.5 3.5 0 0 1 4.9 4.9l-8.4 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8" />
    </Icon>
  );
}

/** Send a message. A paper plane, pointing where it is going. */
export function SendIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21.2 2.8 10.6 13.4" />
      <path d="M21.2 2.8 14.5 21.4l-3.9-8-8-3.9z" />
    </Icon>
  );
}

/**
 * Stop generating.
 *
 * A filled square rather than the outline everything else here uses. It is the
 * one control that interrupts something already happening, and the universal
 * shape for that is solid — an outlined square reads as an empty checkbox.
 */
export function StopIcon({ className = 'h-5 w-5' }: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.6" />
    </svg>
  );
}

/** Start something new: a new chat, another image. */
export function PlusIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

/** Rename. */
export function PencilIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M16.4 3.9a2.3 2.3 0 0 1 3.2 3.2L8.4 18.3l-4.2 1.2 1.2-4.2z" />
      <path d="m14.6 5.7 3.2 3.2" />
    </Icon>
  );
}

/** Copy a reply to the clipboard. Two sheets, one behind the other. */
export function CopyIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
      <path d="M5.5 15H4.8A1.8 1.8 0 0 1 3 13.2V5.3A1.8 1.8 0 0 1 4.8 3.5h7.9A1.8 1.8 0 0 1 14.5 5.3V6" />
    </Icon>
  );
}

/** Ask again. A cycle with a head on it, so it is not read as "in progress". */
export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.7 4.2v5h-5" />
    </Icon>
  );
}

/** Show or hide the conversation sidebar. A panel with its rail marked. */
export function SidebarIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </Icon>
  );
}

/** The way out. A door with an arrow leaving it. */
export function SignOutIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M14.5 4.5H18a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3.5" />
      <path d="M10 8.5 13.5 12 10 15.5" />
      <path d="M13.5 12H4" />
    </Icon>
  );
}

// ---------------------------------------------------------------------------
// Account
//
// One set, added together, for the account menu and the profile sidebar. They
// are drawn at the same weight as everything above so a dropdown does not read
// as having been assembled from a second icon library.
// ---------------------------------------------------------------------------

/** A person in a circle. The account itself, never a photograph. */
export function UserIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="9.8" r="2.8" />
      <path d="M6.6 19a6 6 0 0 1 10.8 0" />
    </Icon>
  );
}

/** A torn ticket. A coupon, distinct from the card icon beside it. */
export function TicketIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3.2 9.4V7a1.8 1.8 0 0 1 1.8-1.8h14a1.8 1.8 0 0 1 1.8 1.8v2.4a2.6 2.6 0 0 0 0 5.2V17a1.8 1.8 0 0 1-1.8 1.8H5A1.8 1.8 0 0 1 3.2 17v-2.4a2.6 2.6 0 0 0 0-5.2Z" />
      <path d="M9.6 14.4 14.4 9.6" />
    </Icon>
  );
}

/** Saved for later. A heart, outline only. */
export function HeartIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 20s-7.4-4.3-7.4-9.1A4.1 4.1 0 0 1 12 8.3a4.1 4.1 0 0 1 7.4 2.6C19.4 15.7 12 20 12 20Z" />
    </Icon>
  );
}

/** What we have sent you. A bell, with its clapper. */
export function BellIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M18 16.4V11a6 6 0 1 0-12 0v5.4L4.4 18.4h15.2Z" />
      <path d="M10.2 18.4a1.8 1.8 0 0 0 3.6 0" />
    </Icon>
  );
}

/** Language and region. A globe with a meridian and its equator. */
export function GlobeIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M3.4 12h17.2" />
      <path d="M12 3.4c2.3 2.4 3.5 5.4 3.5 8.6S14.3 18.2 12 20.6c-2.3-2.4-3.5-5.4-3.5-8.6S9.7 5.8 12 3.4Z" />
    </Icon>
  );
}

/** The buying organisation. An office block, not a house. */
export function BuildingIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4.4 20.6V4.8a1.4 1.4 0 0 1 1.4-1.4h8a1.4 1.4 0 0 1 1.4 1.4v15.8" />
      <path d="M15.2 9.6h3a1.4 1.4 0 0 1 1.4 1.4v9.6" />
      <path d="M3 20.6h18" />
      <path d="M7.8 7.2h3.8M7.8 11h3.8M7.8 14.8h3.8" />
    </Icon>
  );
}

/** Where the invoice goes. A document with a total ruled under it. */
export function ReceiptIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5.4 3.4h13.2v17.2l-2.2-1.4-2.2 1.4-2.2-1.4-2.2 1.4-2.2-1.4-2.2 1.4Z" />
      <path d="M8.6 8h6.8M8.6 11.6h6.8M8.6 15.2h3.4" />
    </Icon>
  );
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

/** Light theme. A sun, with eight rays rather than a filled disc. */
export function SunIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2" />
      <path d="m5.4 5.4 1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6" />
    </Icon>
  );
}

/** Dark theme. A crescent, drawn as one path so it keeps its weight at 20px. */
export function MoonIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.6 8.6 0 1 0 10.4 10.4Z" />
    </Icon>
  );
}

/**
 * Follow the operating system. A display, because that is where the setting
 * being deferred to lives — a half sun / half moon glyph reads as a third
 * theme rather than as "whatever the machine says".
 */
export function DisplayIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2.8" y="4.2" width="18.4" height="12.4" rx="1.8" />
      <path d="M9 20.2h6M12 16.6v3.6" />
    </Icon>
  );
}
