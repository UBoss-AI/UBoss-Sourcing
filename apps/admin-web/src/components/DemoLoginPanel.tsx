/**
 * The sign-ins for a demonstration deployment, printed on the login screen.
 *
 * WHY THIS IS DRIVEN BY AN ENVIRONMENT VARIABLE AND NOT A LIST IN THIS FILE
 *
 * This is a product other companies buy and run themselves. A list of accounts
 * written here would be compiled into every one of their builds, and the first
 * time it appeared on a real installation's login page it would be an
 * unauthenticated disclosure of working credentials. So the component carries
 * no accounts at all: it reads `VITE_DEMO_LOGINS`, and with that unset - which
 * is every ordinary build, because it is set only in a gitignored
 * `.env.netlify.local` - it renders nothing and costs a build one dead branch.
 *
 * WHAT IT MEANS WHERE IT IS SET
 *
 * Anyone who can reach the page can sign in, with whatever the listed accounts
 * can do. That is the intent for a demonstration and is the whole of the
 * access model, so the deployment it is switched on for must hold nothing that
 * matters and its passwords must be demo-only - `npm run db:rotate-seed-passwords`
 * in `backend` is what makes them so.
 *
 * The value is a JSON array: [{ "email": "...", "password": "...", "note": "..." }]
 * `note` is optional and shown as-is. It is demo data written by whoever set
 * the variable, so it is deliberately not translated.
 */
import { useI18n } from '@/i18n/i18n-context';

interface DemoLogin {
  email: string;
  password: string;
  note?: string;
}

interface DemoLoginPanelProps {
  /**
   * The two field labels, passed in rather than looked up here.
   *
   * The three applications name them differently in their catalogues - this
   * one has `auth.email` and `auth.password`, the console and the storefront
   * have `common.emailAddress` and `common.password` - and a lookup of a key
   * an app does not have renders the key itself onto the page. Passing the
   * translated strings keeps this component identical in all three.
   */
  emailLabel: string;
  passwordLabel: string;
}

/**
 * Parse the variable, or give back nothing.
 *
 * Every failure is the same answer - an empty list - because the alternative
 * is a login page that throws. A malformed variable must cost the demo its
 * credentials panel, never cost everybody the ability to sign in.
 */
function readDemoLogins(): DemoLogin[] {
  const raw = import.meta.env.VITE_DEMO_LOGINS;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is DemoLogin => {
      if (typeof entry !== 'object' || entry === null) {
        return false;
      }
      const candidate = entry as Record<string, unknown>;
      return typeof candidate.email === 'string' && typeof candidate.password === 'string';
    });
  } catch {
    return [];
  }
}

export function DemoLoginPanel({
  emailLabel,
  passwordLabel,
}: DemoLoginPanelProps): React.JSX.Element | null {
  const { t } = useI18n();
  const logins = readDemoLogins();

  if (logins.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby="demo-logins-heading"
      className="mt-6 rounded-lg border border-subtle bg-surface-sunken p-4"
    >
      <h2 id="demo-logins-heading" className="text-sm font-semibold text-ink">
        {t('auth.demo.title')}
      </h2>
      <p className="mt-1 text-xs text-ink-muted">{t('auth.demo.intro')}</p>

      <ul className="mt-3 space-y-3">
        {logins.map((login) => (
          <li key={login.email} className="text-xs">
            {/* Two labelled rows rather than "email / password" on one line:
                a password is selected and copied, and a run-on line makes
                somebody drag across the separator and paste it too. */}
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-ink-subtle">{emailLabel}</span>
              <code className="select-all font-mono text-ink">{login.email}</code>
            </div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
              <span className="text-ink-subtle">{passwordLabel}</span>
              <code className="select-all font-mono text-ink">{login.password}</code>
            </div>
            {login.note === undefined ? null : (
              <p className="mt-0.5 text-ink-subtle">{login.note}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
