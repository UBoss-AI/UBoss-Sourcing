/**
 * The Support page's frequently asked questions.
 *
 * Static and translated, not a CMS: the answers describe what this code does,
 * so they change when the code changes, in the same piece of work - which is
 * what a translation catalogue already does for every other sentence here.
 *
 * Every answer is checked against the implementation, and each one is careful
 * about the three things that differ between the companies running this:
 *
 *   - **Settings decide some answers.** Whether people can sign themselves up,
 *     and whether buying for a company exists at all, are deployment choices.
 *     `when` hides a question the deployment makes untrue, and `answer` may pick
 *     between wordings, rather than telling one store's customers another's
 *     rules.
 *   - **Nothing promises a time.** No refund, delivery or reply time is set
 *     anywhere in the product, so no answer names one.
 *   - **Nothing claims what is not built.** No live GPS tracking, no customer
 *     returns screen, no browser list - so there are no questions about them.
 *
 * Ids are stable and never translated: React keys and ARIA ids are built from
 * them, and so is the order, which is the array's.
 */
import type { StorefrontConfig } from '@/lib/types';
import type { TranslationKey } from '@/i18n/i18n-context';

export interface SupportFaqContext {
  features: StorefrontConfig['features'];
  /** Signed in AND activated - the only reader account links are shown to. */
  isCustomer: boolean;
  /** Belongs to at least one buyer company. */
  hasCompany: boolean;
}

/**
 * The next step under an answer.
 *
 * `link` goes to a page in this storefront; `when` is who may see it, so a
 * guest is never shown a link that ends at a sign-in wall, and nobody a link
 * to a sign-up this deployment has closed. `form` brings this
 * page's own request form into view.
 */
export type SupportFaqAction =
  | {
      kind: 'link';
      to: string;
      label: TranslationKey;
      when?: (context: SupportFaqContext) => boolean;
    }
  | { kind: 'form'; label: TranslationKey };

export interface SupportFaqQuestion {
  id: string;
  question: TranslationKey;
  answer: TranslationKey | ((context: SupportFaqContext) => TranslationKey);
  action?: SupportFaqAction;
  /** Absent means always shown. */
  when?: (context: SupportFaqContext) => boolean;
}

export interface SupportFaqCategory {
  id: string;
  name: TranslationKey;
  questions: SupportFaqQuestion[];
}

const companiesOn = (context: SupportFaqContext): boolean => context.features.buyerCompanies === true;
const customer = (context: SupportFaqContext): boolean => context.isCustomer;
const companyMember = (context: SupportFaqContext): boolean =>
  context.isCustomer && context.hasCompany;

export const SUPPORT_FAQ: readonly SupportFaqCategory[] = [
  {
    id: 'accounts',
    name: 'support.faq.cat.accounts',
    questions: [
      {
        id: 'individual-account',
        question: 'support.faq.individualAccount.q',
        answer: (context) =>
          context.features.selfRegistration
            ? 'support.faq.individualAccount.a'
            : 'support.faq.individualAccount.aInvite',
        action: {
          kind: 'link',
          to: '/register',
          label: 'support.faq.action.register',
          when: (context) => context.features.selfRegistration,
        },
        when: (context) => !context.isCustomer,
      },
      {
        id: 'company-account',
        question: 'support.faq.companyAccount.q',
        answer: 'support.faq.companyAccount.a',
        action: {
          kind: 'link',
          to: '/register/company',
          label: 'support.faq.action.registerCompany',
          // Signed out, this page starts with an ordinary sign-up.
          when: (context) => context.isCustomer || context.features.selfRegistration,
        },
        when: companiesOn,
      },
      {
        id: 'company-verification',
        question: 'support.faq.companyVerification.q',
        answer: 'support.faq.companyVerification.a',
        when: companiesOn,
      },
      {
        id: 'verification-status',
        question: 'support.faq.verificationStatus.q',
        answer: 'support.faq.verificationStatus.a',
        action: {
          kind: 'link',
          to: '/account/companies',
          label: 'support.faq.action.verificationStatus',
          when: companyMember,
        },
        when: companiesOn,
      },
      {
        id: 'password',
        question: 'support.faq.password.q',
        answer: 'support.faq.password.a',
        action: { kind: 'link', to: '/forgot-password', label: 'support.faq.action.resetPassword' },
      },
    ],
  },
  {
    id: 'orders',
    name: 'support.faq.cat.orders',
    questions: [
      {
        id: 'view-orders',
        question: 'support.faq.viewOrders.q',
        answer: 'support.faq.viewOrders.a',
        action: {
          kind: 'link',
          to: '/account/orders',
          label: 'support.faq.action.orders',
          when: customer,
        },
      },
      {
        id: 'payment-methods',
        question: 'support.faq.paymentMethods.q',
        answer: 'support.faq.paymentMethods.a',
      },
      {
        id: 'payment-not-confirmed',
        question: 'support.faq.paymentNotConfirmed.q',
        answer: 'support.faq.paymentNotConfirmed.a',
        action: { kind: 'form', label: 'support.faq.action.contact' },
      },
      {
        id: 'invoice',
        question: 'support.faq.invoice.q',
        answer: 'support.faq.invoice.a',
        action: {
          kind: 'link',
          to: '/account/orders',
          label: 'support.faq.action.orders',
          when: customer,
        },
      },
      {
        id: 'cancel-refund',
        question: 'support.faq.cancelRefund.q',
        answer: 'support.faq.cancelRefund.a',
        action: { kind: 'form', label: 'support.faq.action.contact' },
      },
    ],
  },
  {
    id: 'preorders',
    name: 'support.faq.cat.preorders',
    questions: [
      { id: 'what-preorder', question: 'support.faq.whatPreorder.q', answer: 'support.faq.whatPreorder.a' },
      {
        id: 'preorder-minimum',
        question: 'support.faq.preorderMinimum.q',
        answer: 'support.faq.preorderMinimum.a',
      },
      {
        id: 'over-stock',
        question: 'support.faq.overStock.q',
        answer: 'support.faq.overStock.a',
        action: {
          kind: 'link',
          to: '/account/preorders',
          label: 'support.faq.action.preorders',
          when: customer,
        },
      },
      { id: 'units', question: 'support.faq.units.q', answer: 'support.faq.units.a' },
      {
        id: 'individual-limit',
        question: 'support.faq.individualLimit.q',
        answer: 'support.faq.individualLimit.a',
        when: companiesOn,
      },
    ],
  },
  {
    id: 'shipping',
    name: 'support.faq.cat.shipping',
    questions: [
      {
        id: 'track',
        question: 'support.faq.track.q',
        answer: 'support.faq.track.a',
        action: {
          kind: 'link',
          to: '/account/orders',
          label: 'support.faq.action.track',
          when: customer,
        },
      },
      { id: 'levels', question: 'support.faq.levels.q', answer: 'support.faq.levels.a' },
      { id: 'who-delivers', question: 'support.faq.whoDelivers.q', answer: 'support.faq.whoDelivers.a' },
      {
        id: 'tracking-delay',
        question: 'support.faq.trackingDelay.q',
        answer: 'support.faq.trackingDelay.a',
      },
      {
        id: 'delivery-problem',
        question: 'support.faq.deliveryProblem.q',
        answer: 'support.faq.deliveryProblem.a',
        action: { kind: 'form', label: 'support.faq.action.contact' },
      },
    ],
  },
  {
    id: 'sellers',
    name: 'support.faq.cat.sellers',
    questions: [
      {
        id: 'become-seller',
        question: 'support.faq.becomeSeller.q',
        answer: 'support.faq.becomeSeller.a',
        action: { kind: 'link', to: '/sell', label: 'support.faq.action.sell' },
      },
      {
        id: 'seller-approval',
        question: 'support.faq.sellerApproval.q',
        answer: 'support.faq.sellerApproval.a',
      },
      {
        id: 'assign-logistics',
        question: 'support.faq.assignLogistics.q',
        answer: 'support.faq.assignLogistics.a',
      },
      {
        id: 'partner-deliveries',
        question: 'support.faq.partnerDeliveries.q',
        answer: 'support.faq.partnerDeliveries.a',
      },
      { id: 'drivers', question: 'support.faq.drivers.q', answer: 'support.faq.drivers.a' },
    ],
  },
  {
    id: 'technical',
    name: 'support.faq.cat.technical',
    questions: [
      { id: 'erp', question: 'support.faq.erp.q', answer: 'support.faq.erp.a' },
      {
        id: 'erp-needs',
        question: 'support.faq.erpNeeds.q',
        answer: 'support.faq.erpNeeds.a',
      },
      {
        id: 'language-currency',
        question: 'support.faq.languageCurrency.q',
        answer: 'support.faq.languageCurrency.a',
        action: {
          kind: 'link',
          to: '/account/region',
          label: 'support.faq.action.region',
          when: customer,
        },
      },
      {
        id: 'human',
        question: 'support.faq.human.q',
        answer: (context) =>
          context.features.supportTickets === false
            ? 'support.faq.human.aNoTickets'
            : 'support.faq.human.a',
        action: { kind: 'form', label: 'support.faq.action.contact' },
      },
    ],
  },
];

/** The questions this reader should see, in order, with empty topics dropped. */
export function visibleSupportFaq(context: SupportFaqContext): SupportFaqCategory[] {
  return SUPPORT_FAQ.map((category) => ({
    ...category,
    questions: category.questions.filter((question) => question.when?.(context) ?? true),
  })).filter((category) => category.questions.length > 0);
}

/** Whether this reader may see an action's link. */
export function mayFollow(action: SupportFaqAction, context: SupportFaqContext): boolean {
  if (action.kind === 'form') return true;
  return action.when?.(context) ?? true;
}
