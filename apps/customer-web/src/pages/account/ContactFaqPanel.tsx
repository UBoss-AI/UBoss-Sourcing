/**
 * The small print about changing an email address or a telephone number.
 *
 * Written rather than borrowed. The reference this screen was modelled on
 * carries a marketplace's own FAQ — its single-sign-on policy, its seller
 * accounts, its illustration — and none of that is true here: UBOSS is a
 * self-hosted purchasing system, there is no seller account, and the answers
 * are different in ways that matter to somebody who is about to press Edit.
 *
 * Every answer below is a fact about what this code actually does, which is
 * the only kind of FAQ worth having. In particular:
 *
 *   - Confirming an address DOES sign every session out, because the address
 *     is the sign-in identity. That is unusual enough to be worth stating.
 *   - A telephone number is confirmed by a link sent to the *email* address,
 *     because this installation has no SMS provider. Saying so is better than
 *     letting somebody wait for a text that is never coming.
 *   - Order history and invoices survive a change, and survive closing the
 *     account, because tax law requires them to.
 *
 * `<details>` rather than a hand-rolled accordion: it is keyboard- and
 * screen-reader-correct for free, it is searchable by the browser's own find,
 * and it prints expanded.
 */
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { AccountPanel } from './AccountPanel';

const QUESTIONS: readonly { q: TranslationKey; a: TranslationKey }[] = [
  { q: 'profile.faq.updateEmailQ', a: 'profile.faq.updateEmailA' },
  { q: 'profile.faq.whenAppliesQ', a: 'profile.faq.whenAppliesA' },
  { q: 'profile.faq.historyQ', a: 'profile.faq.historyA' },
  { q: 'profile.faq.phoneCodeQ', a: 'profile.faq.phoneCodeA' },
  { q: 'profile.faq.ordersInFlightQ', a: 'profile.faq.ordersInFlightA' },
];

export function ContactFaqPanel(): React.JSX.Element {
  const { t } = useI18n();

  return (
    <AccountPanel title={t('profile.faq.heading')}>
      <div className="divide-y divide-border-subtle">
        {QUESTIONS.map((entry) => (
          <details key={entry.q} className="group py-3 first:pt-0 last:pb-0">
            <summary
              // `cursor-pointer` and a marker of our own: the platform triangle
              // is a different shape and colour on every OS, and this sits in
              // a column of panels that are otherwise consistent.
              className="flex cursor-pointer list-none items-start gap-3 rounded text-sm font-medium text-ink marker:hidden hover:text-brand [&::-webkit-details-marker]:hidden"
            >
              <span
                aria-hidden="true"
                className="mt-1.5 h-2 w-2 shrink-0 rounded-sm bg-brand/60 transition-transform group-open:rotate-45"
              />
              <span className="min-w-0">{t(entry.q)}</span>
            </summary>

            <p className="mt-2 max-w-prose pl-5 text-sm leading-relaxed text-ink-muted">
              {t(entry.a)}
            </p>
          </details>
        ))}
      </div>
    </AccountPanel>
  );
}
