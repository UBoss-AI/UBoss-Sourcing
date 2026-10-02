/**
 * The warning above every composer where buyers and sellers write to each
 * other (JOURNEY-055).
 *
 * Always shown: never send bank details, passwords or card numbers, and the
 * marketplace never asks anybody to pay outside it - which is how most
 * marketplace fraud begins. While somebody types, `detectSensitiveData` looks
 * for what tends to be exactly that (an email address, a long run of digits
 * like a telephone or card number, an IBAN) and a stronger warning appears.
 * The detection itself is `lib/sensitive-data.ts`. Nothing is blocked or rewritten: the message is the sender's own words, and
 * a false alarm on an order number must not stop it being sent.
 */
import { AlertIcon, ShieldIcon } from '@/components/icons';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { detectSensitiveData } from '@/lib/sensitive-data';

export function SensitiveDataNotice({ draft, className }: { draft: string; className?: string }): React.JSX.Element {
  const { t } = useI18n();
  const found = detectSensitiveData(draft);

  return (
    <div className={cx('space-y-2', className)}>
      <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-muted">
        <ShieldIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" />
        {t('messages.safety.notice')}
      </p>
      {found.length > 0 && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-ink"
        >
          <AlertIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            {t('messages.safety.detected', {
              what: found.map((kind) => t(`messages.safety.kind.${kind}` as TranslationKey)).join(', '),
            })}
          </span>
        </p>
      )}
    </div>
  );
}
