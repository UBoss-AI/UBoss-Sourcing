/**
 * Every destination in the account area, written down once.
 *
 * Two surfaces render this list: the dropdown under the profile button in the
 * header, and the sidebar down the left of the account pages. They are the
 * same set of destinations in two shapes, and before this they were two
 * hand-written arrays — which is how the header ends up offering a screen the
 * sidebar has forgotten, or linking to a path that was renamed on one of them.
 *
 * Two shapes, not two lists:
 *
 *   - `accountNavGroups` is the sidebar. Grouped, because the sidebar is
 *     somebody's map of their own account and a flat column of eleven links is
 *     not a map.
 *   - `accountMenuOrder` is the dropdown. Also grouped, but shorter groups and
 *     a different order — a dropdown is read top to bottom in a second, so the
 *     things people came for are first and the settings are last.
 *
 * **A destination is listed only where it leads somewhere.** Scheduled orders
 * are absent from a deployment with recurring orders switched off, not greyed
 * out with a tooltip. That is the same rule `orchestration-nodes.ts` follows
 * for the same reason: an entry that navigates to a 404 teaches the customer
 * that the navigation lies.
 */
import {
  BellIcon,
  BuildingIcon,
  BoxIcon,
  CalendarIcon,
  CardIcon,
  GlobeIcon,
  HeartIcon,
  LinkIcon,
  LocationIcon,
  ReceiptIcon,
  RepeatIcon,
  TicketIcon,
  UserIcon,
} from '@/components/icons';
import type { TranslationKey } from '@/i18n/i18n-context';

export type AccountNavId =
  | 'orders'
  | 'schedules'
  | 'profile'
  | 'company'
  | 'addresses'
  | 'region'
  | 'paymentMethods'
  | 'autopay'
  | 'billing'
  | 'erp'
  | 'coupons'
  | 'wishlist'
  | 'notifications';

export interface AccountNavItem {
  id: AccountNavId;
  to: string;
  /** The long form, for the sidebar. */
  labelKey: TranslationKey;
  /** The short form, for the dropdown, where a row is 220px wide. */
  menuLabelKey: TranslationKey;
  icon: (props: { className?: string }) => React.JSX.Element;
  /**
   * The deployment flag this destination depends on, when it depends on one.
   *
   * Only `recurringOrders` so far. Everything else here is either core to
   * buying or an explanation, and an explanation is never switched off.
   */
  feature?: 'recurringOrders';
}

/** Every destination, by id. The two orderings below index into this. */
export const ACCOUNT_NAV: Readonly<Record<AccountNavId, AccountNavItem>> = {
  orders: {
    id: 'orders',
    to: '/account/orders',
    labelKey: 'account.nav.myOrders',
    menuLabelKey: 'account.nav.orders',
    icon: BoxIcon,
  },
  schedules: {
    id: 'schedules',
    to: '/account/schedules',
    labelKey: 'account.nav.scheduledOrders',
    menuLabelKey: 'account.nav.scheduledOrders',
    icon: CalendarIcon,
    feature: 'recurringOrders',
  },
  profile: {
    id: 'profile',
    to: '/account/profile',
    labelKey: 'account.nav.profileInformation',
    menuLabelKey: 'account.nav.myProfile',
    icon: UserIcon,
  },
  company: {
    id: 'company',
    to: '/account/company',
    labelKey: 'account.nav.companyInformation',
    menuLabelKey: 'account.nav.companyInformation',
    icon: BuildingIcon,
  },
  addresses: {
    id: 'addresses',
    to: '/account/addresses',
    labelKey: 'account.nav.manageAddresses',
    menuLabelKey: 'account.nav.savedAddresses',
    icon: LocationIcon,
  },
  region: {
    id: 'region',
    to: '/account/region',
    labelKey: 'account.nav.languageAndRegion',
    menuLabelKey: 'account.nav.languageAndRegion',
    icon: GlobeIcon,
  },
  paymentMethods: {
    id: 'paymentMethods',
    to: '/account/payment-methods',
    labelKey: 'account.nav.savedPaymentMethods',
    menuLabelKey: 'account.nav.savedPaymentMethods',
    icon: CardIcon,
  },
  autopay: {
    id: 'autopay',
    to: '/account/autopay',
    labelKey: 'account.nav.autoPaySettings',
    menuLabelKey: 'account.nav.autoPay',
    // A repeat glyph rather than a second card: "what pays for it" and "what
    // pays for it again, next month, unattended" are different questions, and
    // a customer scanning a column of icons should not have to tell two cards
    // apart to answer either.
    icon: RepeatIcon,
  },
  billing: {
    id: 'billing',
    to: '/account/billing',
    labelKey: 'account.nav.billingInformation',
    menuLabelKey: 'account.nav.billingInformation',
    icon: ReceiptIcon,
  },
  /*
   * Straight into the working screen, not the explanation that used to live at
   * `/account/erp`.
   *
   * Both surfaces that render this list — the sidebar and the dropdown under
   * the profile button — send somebody to the hub, where they can see the
   * connections their organisation has and start a new one. `/account/erp`
   * still resolves; it redirects here, so an old bookmark lands in the right
   * place rather than on a dead route.
   */
  erp: {
    id: 'erp',
    to: '/account/integrations/erp',
    labelKey: 'account.nav.erpConnections',
    menuLabelKey: 'account.nav.erpIntegrations',
    icon: LinkIcon,
  },
  coupons: {
    id: 'coupons',
    to: '/account/coupons',
    labelKey: 'account.nav.coupons',
    menuLabelKey: 'account.nav.coupons',
    icon: TicketIcon,
  },
  wishlist: {
    id: 'wishlist',
    to: '/account/wishlist',
    labelKey: 'account.nav.wishlist',
    menuLabelKey: 'account.nav.wishlist',
    icon: HeartIcon,
  },
  notifications: {
    id: 'notifications',
    to: '/account/notifications',
    labelKey: 'account.nav.notifications',
    menuLabelKey: 'account.nav.notifications',
    icon: BellIcon,
  },
};

export interface AccountNavGroup {
  titleKey: TranslationKey;
  items: AccountNavItem[];
}

/** What the deployment can offer. Only the flags this file actually reads. */
export interface AccountNavFlags {
  recurringOrders: boolean;
}

function include(ids: readonly AccountNavId[], flags: AccountNavFlags): AccountNavItem[] {
  return ids
    .map((id) => ACCOUNT_NAV[id])
    .filter((item) => item.feature !== 'recurringOrders' || flags.recurringOrders);
}

/**
 * The sidebar.
 *
 * Groups in the order somebody works down them: what they have bought, who
 * they are, how it gets paid for, what talks to their own systems, and the
 * odds and ends. A group whose every item is switched off does not render —
 * see `AccountLayout`, which drops empty groups rather than leaving a heading
 * with nothing under it.
 */
export function accountNavGroups(flags: AccountNavFlags): AccountNavGroup[] {
  const groups: AccountNavGroup[] = [
    { titleKey: 'account.group.orders', items: include(['orders', 'schedules'], flags) },
    {
      titleKey: 'account.group.accountSettings',
      items: include(['profile', 'company', 'addresses', 'region'], flags),
    },
    {
      titleKey: 'account.group.payments',
      items: include(['paymentMethods', 'autopay', 'billing'], flags),
    },
    { titleKey: 'account.group.integrations', items: include(['erp'], flags) },
    {
      titleKey: 'account.group.myStuff',
      items: include(['coupons', 'wishlist', 'notifications'], flags),
    },
  ];

  // A group whose every item is switched off is a heading with nothing under
  // it, which reads as a failed render rather than as a feature this
  // deployment does not have.
  return groups.filter((group) => group.items.length > 0);
}

/**
 * The dropdown.
 *
 * Shorter and in a different order: this is read in about a second, so the
 * profile and the orders come first, then money, then the odds and ends. The
 * headings are kept — a dropdown of eleven links with no grouping is a list
 * nobody scans, they just read it from the top until something matches.
 */
export function accountMenuGroups(flags: AccountNavFlags): AccountNavGroup[] {
  const groups: AccountNavGroup[] = [
    { titleKey: 'account.group.yourAccount', items: include(['profile'], flags) },
    { titleKey: 'account.group.orders', items: include(['orders', 'schedules'], flags) },
    {
      titleKey: 'account.group.payments',
      items: include(['paymentMethods', 'autopay', 'coupons'], flags),
    },
    {
      titleKey: 'account.group.details',
      items: include(['addresses', 'wishlist', 'notifications', 'erp'], flags),
    },
  ];

  // A group whose every item is switched off is a heading with nothing under
  // it, which reads as a failed render rather than as a feature this
  // deployment does not have.
  return groups.filter((group) => group.items.length > 0);
}
