/**
 * The panel's icon set.
 *
 * Inline SVG rather than an icon font or a runtime dependency — the same
 * decision, and the same three rules, as apps/customer-web/src/components/
 * icons.tsx. One brand, one drawing style:
 *
 *   - **`currentColor`, never a fixed hue.** An icon takes the colour of the
 *     text beside it, so it cannot drift out of step with the palette or fail
 *     contrast on a surface it was not drawn for. That matters twice over
 *     here, where the same nav icon is drawn on navy and the same status icon
 *     on a tinted alert row.
 *   - **`aria-hidden`, always.** Every icon in this panel sits next to a real
 *     label. An icon that announces itself makes a screen reader read the
 *     same thing twice.
 *   - **One stroke weight (1.7) and one viewBox (24).** Mixed weights are what
 *     makes a sidebar look assembled from three different sets, and a sidebar
 *     is where fourteen of these sit in a single column.
 *
 * The navigation icons are deliberately plain: a box is a box, a card is a
 * card. This sidebar is read by people who use it every day, and the icon's
 * job is to give each row a distinct silhouette to aim at — not to explain
 * what the page does, which the label already did.
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

/** What the navigation map stores against each item. */
export type IconComponent = (props: IconProps) => React.JSX.Element;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export function DashboardIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3.4" y="3.4" width="7.2" height="6" rx="1.6" />
      <rect x="3.4" y="12.6" width="7.2" height="8" rx="1.6" />
      <rect x="13.4" y="3.4" width="7.2" height="8" rx="1.6" />
      <rect x="13.4" y="14.6" width="7.2" height="6" rx="1.6" />
    </Icon>
  );
}

export function CategoriesIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4.4 5.4h2.4M4.4 12h2.4M4.4 18.6h2.4" />
      <path d="M10.4 5.4h9.2M10.4 12h9.2M10.4 18.6h9.2" />
    </Icon>
  );
}

export function ProductsIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m12 2.8 8.6 4.6v9.2L12 21.2l-8.6-4.6V7.4z" />
      <path d="m3.4 7.4 8.6 4.6 8.6-4.6M12 12v9.2" />
    </Icon>
  );
}

export function InventoryIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3.4" y="3.6" width="17.2" height="5" rx="1.4" />
      <path d="M5 8.6v10a1.8 1.8 0 0 0 1.8 1.8h10.4a1.8 1.8 0 0 0 1.8-1.8v-10" />
      <path d="M10 12.6h4" />
    </Icon>
  );
}

export function CouponsIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3.6 8.8V6.6a1.4 1.4 0 0 1 1.4-1.4h14a1.4 1.4 0 0 1 1.4 1.4v2.2a2.4 2.4 0 0 0 0 6.4v2.2a1.4 1.4 0 0 1-1.4 1.4H5a1.4 1.4 0 0 1-1.4-1.4v-2.2a2.4 2.4 0 0 0 0-6.4z" />
      <path d="M13.4 9.2v1.6M13.4 13.2v1.6" />
    </Icon>
  );
}

export function OrdersIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5.6 3.6h12.8v16.8l-2.14-1.5-2.13 1.5-2.13-1.5-2.14 1.5-2.13-1.5-2.13 1.5z" />
      <path d="M9 8.6h6M9 12.6h6" />
    </Icon>
  );
}

export function PaymentsIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2.8" y="5.4" width="18.4" height="13.2" rx="2.2" />
      <path d="M2.8 9.8h18.4M6.4 14.6h3.4" />
    </Icon>
  );
}

export function RecurringIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m16.5 3 3 3-3 3" />
      <path d="M19.5 6H8.5A4.5 4.5 0 0 0 4 10.5v1" />
      <path d="m7.5 21-3-3 3-3" />
      <path d="M4.5 18h11A4.5 4.5 0 0 0 20 13.5v-1" />
    </Icon>
  );
}

export function CustomersIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="9.2" cy="8.4" r="3.4" />
      <path d="M3.4 19.6a5.8 5.8 0 0 1 11.6 0" />
      <path d="M16.4 5.6a3.2 3.2 0 0 1 0 5.8M17.8 14.6a5.8 5.8 0 0 1 2.8 5" />
    </Icon>
  );
}

/** Chat enquiries from the storefront widget. A speech bubble, nothing more. */
export function ChatIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M20.4 11.6a7.6 7.6 0 0 1-7.6 7.6 8 8 0 0 1-3.4-.8L4.6 20l1.4-4.4a8 8 0 0 1-.8-3.4 7.6 7.6 0 0 1 15.2-.6z" />
      <path d="M9.2 11.6h6" />
    </Icon>
  );
}

export function ReportsIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3.6 20.4h16.8" />
      <path d="M6.8 20.4v-6M11.6 20.4V7.8M16.4 20.4v-9.2" />
    </Icon>
  );
}

export function AuditIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3.6 12a8.4 8.4 0 1 0 2.6-6" />
      <path d="M3.4 3.6v3.2h3.2" />
      <path d="M12 7.8V12l3 1.8" />
    </Icon>
  );
}

export function IntegrationsIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8.6 3.4v4M15.4 3.4v4" />
      <path d="M6 7.4h12v4.2a6 6 0 0 1-12 0z" />
      <path d="M12 17.6v3" />
    </Icon>
  );
}

export function StaffIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3.4" y="6.6" width="17.2" height="14" rx="2.2" />
      <path d="M9 6.6V5.2a1.8 1.8 0 0 1 1.8-1.8h2.4A1.8 1.8 0 0 1 15 5.2v1.4" />
      <circle cx="12" cy="12.2" r="2.2" />
      <path d="M8.4 18.2a3.8 3.8 0 0 1 7.2 0" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 7.4h9.6M18.4 7.4h1.6M4 16.6h3.6M12.4 16.6h7.6" />
      <circle cx="16" cy="7.4" r="2.4" />
      <circle cx="10" cy="16.6" r="2.4" />
    </Icon>
  );
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

export function MenuIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 6.6h16M4 12h16M4 17.4h16" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
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

export function SignOutIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M14.4 7.4V5.6A1.6 1.6 0 0 0 12.8 4H5.6A1.6 1.6 0 0 0 4 5.6v12.8A1.6 1.6 0 0 0 5.6 20h7.2a1.6 1.6 0 0 0 1.6-1.6v-1.8" />
      <path d="M9.6 12h10.8M17.4 8.8 20.6 12l-3.2 3.2" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M20.4 12a8.4 8.4 0 1 1-2.6-6" />
      <path d="M20.6 3.6v3.2h-3.2" />
    </Icon>
  );
}

// ---------------------------------------------------------------------------
// Operational cues
//
// Two severities, two silhouettes. A triangle and a circle are told apart at a
// glance and without colour, which is the point of pairing an icon with a tone
// rather than leaning on the tone alone.
// ---------------------------------------------------------------------------

export function AlertTriangleIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 3.8 21 19.4H3z" />
      <path d="M12 9.6v4M12 16.4h.01" />
    </Icon>
  );
}

export function AlertCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.8v5M12 16.1h.01" />
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
