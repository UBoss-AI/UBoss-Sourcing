/**
 * The sidebar, as data.
 *
 * One list, read by the rail and by the mobile drawer, so the two cannot
 * disagree about what exists. Each entry names the permissions that make it
 * useful; an entry nobody in this role can use is not rendered at all, which
 * is more honest than rendering it and refusing the click. A courtesy, never a
 * control: the server refuses the request either way.
 *
 * `anyOf` rather than `allOf` throughout: a screen is worth opening if any one
 * of its panels is. The panels inside it do their own narrowing.
 */
import {
  AlertTriangleIcon,
  AuditIcon,
  ClockIcon,
  DashboardIcon,
  DataProtectionIcon,
  InsightsIcon,
  ListingReviewIcon,
  OrdersIcon,
  ProductsIcon,
  ProfileIcon,
  ReportsIcon,
  SellerIcon,
  StaffIcon,
} from '@/components/icons';
import type { PermissionKey } from '@/lib/permissions';
import { Permission } from '@/lib/permissions';
import type { TranslationKey } from '@/i18n/i18n-context';

export interface NavEntry {
  to: string;
  labelKey: TranslationKey;
  icon: (props: { className?: string }) => React.JSX.Element;
  anyOf: PermissionKey[];
}

export interface NavSection {
  /** Null for the first group, which needs no heading above the dashboard. */
  labelKey: TranslationKey | null;
  entries: NavEntry[];
}

/**
 * Grouped by the question a person is answering: is this seller who they say
 * they are (verification), did the goods pass (inspection), and what are the
 * rules (standards). An inspector holds only the inspection keys, so their
 * rail is the middle group and their profile, and nothing else.
 */
export const NAVIGATION: readonly NavSection[] = [
  {
    labelKey: null,
    entries: [
      {
        to: '/dashboard',
        labelKey: 'nav.dashboard',
        icon: DashboardIcon,
        anyOf: [Permission.DASHBOARD_READ],
      },
    ],
  },
  {
    labelKey: 'nav.verification',
    entries: [
      {
        to: '/seller-verification',
        labelKey: 'nav.sellerVerification',
        icon: ListingReviewIcon,
        anyOf: [Permission.SELLER_READ],
      },
      {
        // Seller Assessment and Onboarding: eight gates, scope, certification, release.
        to: '/seller-assessments',
        labelKey: 'nav.sellerAssessment',
        icon: ListingReviewIcon,
        anyOf: [Permission.ASSESSMENT_READ],
      },
      {
        // Between L1 and L2: assess, waive by badge, release or hold.
        to: '/shipment-assessment',
        labelKey: 'nav.shipmentAssessment',
        icon: OrdersIcon,
        anyOf: [Permission.SHIPMENT_READ],
      },
      {
        // Doc 08: product evidence per SKU/version, site and country.
        to: '/product-evidence',
        labelKey: 'nav.productEvidence',
        icon: ProductsIcon,
        anyOf: [Permission.ASSESSMENT_READ],
      },
      {
        // Doc 07: product safety cases, containment, recall and release.
        to: '/safety-cases',
        labelKey: 'nav.safetyCases',
        icon: AlertTriangleIcon,
        anyOf: [Permission.ASSESSMENT_READ],
      },
      { to: '/sellers', labelKey: 'nav.sellers', icon: SellerIcon, anyOf: [Permission.SELLER_READ] },
      { to: '/products', labelKey: 'nav.products', icon: ProductsIcon, anyOf: [Permission.SELLER_READ] },
      {
        to: '/documents',
        labelKey: 'nav.documents',
        icon: DataProtectionIcon,
        anyOf: [Permission.DOCUMENT_READ],
      },
    ],
  },
  {
    labelKey: 'nav.inspection',
    entries: [
      {
        to: '/jobs',
        labelKey: 'nav.jobs',
        icon: OrdersIcon,
        anyOf: [Permission.JOB_READ, Permission.JOB_OVERSEE],
      },
      { to: '/calendar', labelKey: 'nav.calendar', icon: ClockIcon, anyOf: [Permission.JOB_READ] },
      {
        to: '/reports',
        labelKey: 'nav.reports',
        icon: ReportsIcon,
        anyOf: [Permission.JOB_READ, Permission.JOB_OVERSEE],
      },
      {
        // QIMA-style quality insights. Audit staff only: it reads every agency.
        to: '/insights',
        labelKey: 'nav.insights',
        icon: InsightsIcon,
        anyOf: [Permission.JOB_OVERSEE],
      },
      {
        to: '/corrective-actions',
        labelKey: 'nav.correctiveActions',
        icon: AlertTriangleIcon,
        anyOf: [Permission.JOB_READ, Permission.JOB_OVERSEE],
      },
    ],
  },
  {
    labelKey: 'nav.standards',
    entries: [
      { to: '/rules', labelKey: 'nav.rules', icon: AuditIcon, anyOf: [Permission.RULE_READ] },
      {
        to: '/checklists',
        labelKey: 'nav.checklists',
        icon: ListingReviewIcon,
        anyOf: [Permission.CHECKLIST_MANAGE],
      },
    ],
  },
  {
    labelKey: 'nav.account',
    entries: [
      {
        to: '/team',
        labelKey: 'nav.team',
        icon: StaffIcon,
        anyOf: [Permission.MEMBER_WRITE, Permission.TEAM_READ],
      },
      // Every member: their own password, second factor and language.
      { to: '/profile', labelKey: 'nav.profile', icon: ProfileIcon, anyOf: [] },
    ],
  },
];

/**
 * Which entry a path belongs to. The LONGEST match wins, so `/jobs/01J...`
 * lights Jobs rather than whichever entry happens to be first.
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
    // An empty list is "any member", as it is for the route guard.
    entries: section.entries.filter((entry) => entry.anyOf.length === 0 || canAny(...entry.anyOf)),
  })).filter((section) => section.entries.length > 0);
}
