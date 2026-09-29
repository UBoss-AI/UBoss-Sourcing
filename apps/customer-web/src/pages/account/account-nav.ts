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
  ChatBubblesIcon,
  ChartIcon,
  DocumentIcon,
  GlobeIcon,
  HeadsetIcon,
  HeartIcon,
  LayersIcon,
  LinkIcon,
  LocationIcon,
  ReceiptIcon,
  RepeatIcon,
  ShieldIcon,
  StarIcon,
  TicketIcon,
  UserIcon,
} from '@/components/icons';
import type { TranslationKey } from '@/i18n/i18n-context';

export type AccountNavId =
  | 'dashboard'
  | 'orders'
  | 'schedules'
  | 'preorders'
  | 'rfqs'
  | 'messages'
  | 'profile'
  | 'identity'
  | 'security'
  | 'company'
  | 'companies'
  | 'addresses'
  | 'region'
  | 'paymentMethods'
  | 'autopay'
  | 'billing'
  | 'erp'
  | 'coupons'
  | 'wishlist'
  | 'reviews'
  | 'notifications'
  | 'support'
  | 'supportRequests';

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
   * `recurringOrders`, `buyerCompanies` and `productReviews`. Everything else here is either
   * core to buying or an explanation, and an explanation is never switched off.
   */
  feature?: 'recurringOrders' | 'buyerCompanies' | 'productReviews' | 'rfq';
}

/** Every destination, by id. The two orderings below index into this. */
export const ACCOUNT_NAV: Readonly<Record<AccountNavId, AccountNavItem>> = {
  /*
   * First in the table and first in both orderings, because it is where
   * `/account` now lands and because it is the one screen here that answers a
   * question somebody has not thought to ask yet.
   */
  dashboard: {
    id: 'dashboard',
    to: '/account/dashboard',
    labelKey: 'account.nav.dashboard',
    menuLabelKey: 'account.nav.dashboard',
    icon: ChartIcon,
  },
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
  // Bulk preorders: a negotiation with a seller before an order exists. Not
  // behind a feature flag - the product page offers Preorder everywhere, so
  // the place to follow one has to exist everywhere too.
  preorders: {
    id: 'preorders',
    to: '/account/preorders',
    labelKey: 'account.nav.preorders',
    menuLabelKey: 'account.nav.preorders',
    icon: LayersIcon,
  },
  // Requests for quotation: what the buyer asked sellers to quote on, and
  // their answers. Beside preorders - both are a negotiation before an order.
  rfqs: {
    id: 'rfqs',
    to: '/account/rfqs',
    labelKey: 'rfq.nav',
    menuLabelKey: 'rfq.nav',
    icon: DocumentIcon,
    feature: 'rfq',
  },
  // Preorder chats with the UBOSS team. Beside preorders, because that is what
  // they are about; not behind a flag the storefront reads, because the chat
  // button that starts one is on every product page.
  messages: {
    id: 'messages',
    to: '/account/messages',
    labelKey: 'preorderChat.nav',
    menuLabelKey: 'preorderChat.nav',
    icon: ChatBubblesIcon,
  },
  profile: {
    id: 'profile',
    to: '/account/profile',
    labelKey: 'account.nav.profileInformation',
    menuLabelKey: 'account.nav.myProfile',
    icon: UserIcon,
  },
  // An individual's identity check and importer details. Beside the profile,
  // because it is about the same person; company buyers are checked through
  // the company application instead.
  identity: {
    id: 'identity',
    to: '/account/identity',
    labelKey: 'account.nav.identity',
    menuLabelKey: 'account.nav.identity',
    icon: ShieldIcon,
  },
  // Password and two-step sign-in. They live in panels on the profile page, so
  // this goes there and lands on them; it is offered in the dropdown only, where
  // "Security" is a thing people look for, and not as a second sidebar row that
  // would light up together with Profile.
  security: {
    id: 'security',
    to: '/account/profile#security',
    labelKey: 'account.nav.security',
    menuLabelKey: 'account.nav.security',
    icon: ShieldIcon,
  },
  company: {
    id: 'company',
    to: '/account/company',
    labelKey: 'account.nav.companyInformation',
    menuLabelKey: 'account.nav.companyInformation',
    icon: BuildingIcon,
  },
  /*
   * The companies this person registered or belongs to, and the verification
   * of each. Beside "Company information", which is the free-text employer on
   * the person's own profile - a different thing that predates it.
   */
  companies: {
    id: 'companies',
    to: '/account/companies',
    labelKey: 'account.nav.companyAccounts',
    menuLabelKey: 'account.nav.companyAccounts',
    icon: BuildingIcon,
    feature: 'buyerCompanies',
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
  // Products received but not rated yet, and the reviews written. Only where
  // the deployment has reviews switched on.
  reviews: {
    id: 'reviews',
    to: '/account/reviews',
    labelKey: 'account.nav.reviews',
    menuLabelKey: 'account.nav.reviews',
    icon: StarIcon,
    feature: 'productReviews',
  },
  notifications: {
    id: 'notifications',
    to: '/account/notifications',
    labelKey: 'account.nav.notifications',
    menuLabelKey: 'account.nav.notifications',
    icon: BellIcon,
  },
  // The Support page itself. In the dropdown, because on a phone the header's
  // Support link is not shown and this is the way there.
  support: {
    id: 'support',
    to: '/support',
    labelKey: 'account.nav.support',
    menuLabelKey: 'account.nav.support',
    icon: HeadsetIcon,
  },
  // The requests sent from it, with their replies, in the sidebar. Named
  // "Support" like every other Support entry point.
  supportRequests: {
    id: 'supportRequests',
    to: '/account/support',
    labelKey: 'account.nav.support',
    menuLabelKey: 'account.nav.support',
    icon: HeadsetIcon,
  },
};

export interface AccountNavGroup {
  titleKey: TranslationKey;
  items: AccountNavItem[];
}

/** What the deployment can offer. Only the flags this file actually reads. */
export interface AccountNavFlags {
  recurringOrders: boolean;
  /** Optional so an older caller still compiles; absent means off. */
  buyerCompanies?: boolean;
  /** Optional so an older caller still compiles; absent means off. */
  productReviews?: boolean;
  /** Optional so an older caller still compiles; absent means off. */
  rfq?: boolean;
}

function include(ids: readonly AccountNavId[], flags: AccountNavFlags): AccountNavItem[] {
  return ids
    .map((id) => ACCOUNT_NAV[id])
    .filter((item) => item.feature !== 'recurringOrders' || flags.recurringOrders)
    .filter((item) => item.feature !== 'buyerCompanies' || flags.buyerCompanies === true)
    .filter((item) => item.feature !== 'productReviews' || flags.productReviews === true)
    .filter((item) => item.feature !== 'rfq' || flags.rfq === true);
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
    {
      titleKey: 'account.group.orders',
      items: include(['dashboard', 'orders', 'schedules', 'preorders', 'rfqs', 'messages'], flags),
    },
    {
      titleKey: 'account.group.accountSettings',
      items: include(['profile', 'identity', 'company', 'companies', 'addresses', 'region'], flags),
    },
    {
      titleKey: 'account.group.payments',
      items: include(['paymentMethods', 'autopay', 'billing'], flags),
    },
    { titleKey: 'account.group.integrations', items: include(['erp'], flags) },
    {
      titleKey: 'account.group.myStuff',
      items: include(['coupons', 'wishlist', 'reviews', 'notifications', 'supportRequests'], flags),
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
    { titleKey: 'account.group.yourAccount', items: include(['dashboard', 'profile', 'security'], flags) },
    { titleKey: 'account.group.orders', items: include(['orders', 'schedules', 'preorders', 'rfqs', 'messages'], flags) },
    {
      titleKey: 'account.group.payments',
      items: include(['paymentMethods', 'autopay', 'coupons'], flags),
    },
    {
      titleKey: 'account.group.details',
      items: include(['identity', 'companies', 'addresses', 'wishlist', 'reviews', 'notifications', 'erp', 'support'], flags),
    },
  ];

  // A group whose every item is switched off is a heading with nothing under
  // it, which reads as a failed render rather than as a feature this
  // deployment does not have.
  return groups.filter((group) => group.items.length > 0);
}
