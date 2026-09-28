/**
 * The Support page's FAQ: the questions in `lib/support-faq.ts`, translated,
 * filtered for this deployment and this reader, and drawn by `FaqCategorized`.
 *
 * Two things this adds around the list:
 *
 *   - **Links only the reader can follow.** An answer's link to an account
 *     page is left out for a guest rather than shown and then refused, and a
 *     link to a sign-up this deployment has closed is not shown at all.
 *   - **"Contact support" stays on this page.** It scrolls to the request form
 *     and moves focus to its heading - not into a field, and never through a
 *     navigation, so nothing already typed in the form is touched.
 *
 * Wrapped in its own error boundary: if the FAQ ever fails to render, the
 * section disappears and the form under it keeps working. A question nobody
 * can read is a nuisance; a Support page with no way to write in is an outage.
 */
import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { Link, NavigationType, useLocation, useNavigationType } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { useSession } from '@/auth/session-context';
import {
  BoxIcon,
  BuildingIcon,
  ChevronRightIcon,
  FlowIcon,
  ReceiptIcon,
  ShieldIcon,
  TruckIcon,
} from '@/components/icons';
import { useI18n } from '@/i18n/i18n-context';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';
import {
  mayFollow,
  visibleSupportFaq,
  type SupportFaqAction,
  type SupportFaqContext,
} from '@/lib/support-faq';
import { FaqCategorized, type FaqCategory } from './FaqCategorized';

/** The section's anchor: `/support#support-faq`. */
export const SUPPORT_FAQ_ID = 'support-faq';

/** Each topic's tile icon, by the topic's stable id. */
const TOPIC_ICONS: Partial<Record<string, NonNullable<FaqCategory['icon']>>> = {
  accounts: ShieldIcon,
  orders: ReceiptIcon,
  preorders: BoxIcon,
  shipping: TruckIcon,
  sellers: BuildingIcon,
  technical: FlowIcon,
};

class FaqBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Support FAQ failed to render', error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

const ACTION_CLASS =
  'inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';

function iconFor(topicId: string): Pick<FaqCategory, 'icon'> {
  const icon = TOPIC_ICONS[topicId];
  return icon === undefined ? {} : { icon };
}

function FaqAction({
  action,
  formId,
}: {
  action: SupportFaqAction;
  formId: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const reduced = usePrefersReducedMotion();

  if (action.kind === 'link') {
    return (
      <Link to={action.to} className={ACTION_CLASS}>
        {t(action.label)}
        <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
      </Link>
    );
  }

  return (
    <button
      type="button"
      className={ACTION_CLASS}
      onClick={() => {
        const card = document.getElementById(formId);
        card?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
        document.getElementById(`${formId}-heading`)?.focus({ preventScroll: true });
      }}
    >
      {t(action.label)}
      <ChevronRightIcon aria-hidden="true" className="h-4 w-4 rotate-90" />
    </button>
  );
}

/**
 * `/support#support-faq` lands on the questions.
 *
 * The browser's own jump to a fragment finds nothing - this route is loaded
 * lazily, so the section does not exist yet when it looks - and on a link
 * inside the app `useRouteScroll` sends a new page to the top. Its layout
 * effect runs before this passive one, and the frame after that is when the
 * section is placed. Back and Forward are left to the position they restore.
 */
function useLandOnFragment(id: string): void {
  const location = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (location.hash !== `#${id}`) return undefined;
    // A first load is a POP too; Back and Forward have already moved the page.
    if (navigationType === NavigationType.Pop && window.scrollY > 0) return undefined;
    const frame = requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [id, location.hash, location.key, navigationType]);
}

function SupportFaqList({ formId }: { formId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  useLandOnFragment(SUPPORT_FAQ_ID);
  const { features } = useStorefront();
  const { isCustomer, companies } = useSession();

  const context: SupportFaqContext = { features, isCustomer, hasCompany: companies.length > 0 };

  const categories: FaqCategory[] = visibleSupportFaq(context).map((category) => ({
    id: category.id,
    name: t(category.name),
    ...iconFor(category.id),
    faqs: category.questions.map((question) => {
      const answerKey =
        typeof question.answer === 'function' ? question.answer(context) : question.answer;
      const action =
        question.action !== undefined && mayFollow(question.action, context)
          ? question.action
          : undefined;
      return {
        id: question.id,
        question: t(question.question),
        answer: t(answerKey),
        ...(action !== undefined ? { action: <FaqAction action={action} formId={formId} /> } : {}),
      };
    }),
  }));

  return (
    <FaqCategorized
      id={SUPPORT_FAQ_ID}
      title={t('support.faq.title')}
      description={t('support.faq.description')}
      tabListLabel={t('support.faq.topics')}
      countLabel={(count) => t('support.faq.count', { count })}
      categories={categories}
    />
  );
}

export function SupportFaq({ formId }: { formId: string }): React.JSX.Element {
  return (
    <FaqBoundary>
      <SupportFaqList formId={formId} />
    </FaqBoundary>
  );
}
