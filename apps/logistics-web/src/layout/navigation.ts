/**
 * The sidebar, as data.
 *
 * One list, read by the sidebar and by the mobile drawer, so the two cannot
 * disagree about what exists. Each entry names the permissions that make it
 * useful; an entry nobody in this role can use is not rendered at all, which
 * is more honest than rendering it and refusing the click.
 *
 * `anyOf` rather than `allOf` throughout: a screen is worth opening if any one
 * of its panels is. The panels inside it do their own narrowing.
 */
import {
  AlertTriangleIcon,
  CustomersIcon,
  DashboardIcon,
  OrdersIcon,
  ProfileIcon,
  SellerIcon,
  StaffIcon,
  WarehouseIcon,
} from '@/components/icons';
import type { PermissionKey } from '@/lib/permissions';
import { Permission } from '@/lib/permissions';
import type { TranslationKey } from '@/i18n/i18n-context';

export interface NavEntry {
  to: string;
  labelKey: TranslationKey;
  icon: (props: { className?: string }) => React.JSX.Element;
  anyOf: PermissionKey[];
  /** Shows the open-exception count beside the label. */
  badge?: 'exceptions';
}

export interface NavSection {
  /** Null for the first group, which needs no heading above the dashboard. */
  labelKey: TranslationKey | null;
  entries: NavEntry[];
}

/**
 * The order is the order a day happens in.
 *
 * Dashboard, then the work (shipments, collections, dispatch), then the
 * problems, then the reference (companies, fleet), then the company itself.
 * A dispatcher reads down this list as their shift progresses, which is why it
 * is not alphabetical and not grouped by permission.
 */
export const NAVIGATION: readonly NavSection[] = [
  {
    labelKey: null,
    entries: [
      {
        to: '/dashboard',
        labelKey: 'nav.dashboard',
        icon: DashboardIcon,
        // Every member of the company can open it; the panels inside narrow
        // themselves.
        anyOf: [Permission.SHIPMENT_READ],
      },
      {
        /*
         * A driver's own list.
         *
         * First in the list for them and absent for everybody else, because a
         * driver holds DRIVER_TASK_READ and nothing else - this is the only
         * entry their sidebar has, and it should be the one their thumb lands
         * on.
         */
        to: '/driver/tasks',
        labelKey: 'nav.myTasks',
        icon: OrdersIcon,
        anyOf: [Permission.DRIVER_TASK_READ],
      },
    ],
  },
  {
    labelKey: 'nav.shipments',
    entries: [
      {
        to: '/shipments',
        labelKey: 'nav.shipments',
        icon: OrdersIcon,
        anyOf: [Permission.SHIPMENT_READ],
      },
      {
        to: '/legs',
        labelKey: 'nav.legs',
        icon: OrdersIcon,
        anyOf: [Permission.SHIPMENT_READ],
      },
      {
        to: '/pickups',
        labelKey: 'nav.pickups',
        icon: WarehouseIcon,
        anyOf: [Permission.PICKUP_READ],
      },
      {
        to: '/dispatch',
        labelKey: 'nav.dispatch',
        icon: SellerIcon,
        anyOf: [Permission.DISPATCH_READ],
      },
      {
        to: '/exceptions',
        labelKey: 'nav.exceptions',
        icon: AlertTriangleIcon,
        anyOf: [Permission.SHIPMENT_READ],
        badge: 'exceptions',
      },
    ],
  },
  {
    labelKey: 'nav.companies',
    entries: [
      {
        to: '/companies',
        labelKey: 'nav.companies',
        icon: CustomersIcon,
        anyOf: [Permission.COMPANY_READ],
      },
      {
        to: '/drivers',
        labelKey: 'nav.drivers',
        icon: StaffIcon,
        anyOf: [Permission.DRIVER_READ, Permission.VEHICLE_READ],
      },
      {
        /*
         * The company's own profile: identity, contacts, coverage, compliance
         * documents and integration status. Anybody who can read the company
         * record can open it; only an owner or administrator can change it.
         */
        to: '/profile',
        labelKey: 'nav.myProfile',
        icon: ProfileIcon,
        anyOf: [Permission.ORGANISATION_READ],
      },
      {
        to: '/company',
        labelKey: 'nav.company',
        icon: SellerIcon,
        anyOf: [Permission.ORGANISATION_READ],
      },
      {
        /*
         * Beside the company record rather than under Shipments: what this
         * screen answers is "is our side of this working", which is a question
         * about the company, not about any one parcel.
         */
        to: '/integration',
        labelKey: 'nav.integration',
        icon: SellerIcon,
        anyOf: [Permission.INTEGRATION_READ],
      },
    ],
  },
];

/**
 * Which entry a path belongs to.
 *
 * The LONGEST match wins, so `/shipments/01J...` lights Shipments rather than
 * whichever entry happens to be first with a matching prefix. The console's
 * own sidebar learned this the same way.
 */
export function locateRoute(pathname: string): string | null {
  let best: string | null = null;

  for (const section of NAVIGATION) {
    for (const entry of section.entries) {
      if (pathname === entry.to || pathname.startsWith(`${entry.to}/`)) {
        if (best === null || entry.to.length > best.length) best = entry.to;
      }
    }
  }

  return best;
}

/** The entries this person can actually use. Empty sections are dropped. */
export function visibleNavigation(
  canAny: (...permissions: PermissionKey[]) => boolean,
): NavSection[] {
  return NAVIGATION.map((section) => ({
    ...section,
    entries: section.entries.filter((entry) => canAny(...entry.anyOf)),
  })).filter((section) => section.entries.length > 0);
}
