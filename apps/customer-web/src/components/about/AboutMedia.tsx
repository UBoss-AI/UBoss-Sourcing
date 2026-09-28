/**
 * The picture beside "What we do": the earth, with the people the marketplace
 * connects placed around it.
 *
 * The approved reference put a stock photograph here with a play button on it.
 * Neither survives: there is no approved introduction video, and a play button
 * that plays nothing is a broken control. What replaces them has to earn its
 * place, so the picture carries information - the groups who take part are a
 * real list, read out by a screen reader as one, and only the earth and its
 * orbit are decoration.
 *
 * From `sm` up the groups sit on an orbit around the globe. Below it there is
 * no room for that without the longer languages running off the panel, so they
 * drop into a two-column grid under the earth instead. Same list, same order.
 */
import earthUrl from '@/assets/globe/earth-blue-marble-sm.jpg';
import { useStorefront } from '@/app/storefront-context';
import { useI18n } from '@/i18n/i18n-context';
import { aboutRoles, orbitPosition, type AboutRoleKey } from './about-content';
import './about-globe.css';

function roleKey(key: AboutRoleKey): `about.media.role.${AboutRoleKey}` {
  return `about.media.role.${key}`;
}

export function AboutMedia(): React.JSX.Element {
  const { t } = useI18n();
  const { features } = useStorefront();
  const roles = aboutRoles(features);

  return (
    <figure className="relative w-full max-w-md shrink-0 overflow-hidden rounded-2xl bg-navy p-5 shadow-2xl shadow-brand/30 ring-1 ring-inset ring-white/10 sm:p-6">
      {/* A soft wash from the top corner. A gradient rather than a blurred
          element: a 300px blur is a real cost on a phone for a glow. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgb(56_189_248/0.22),transparent_55%),radial-gradient(circle_at_100%_100%,rgb(45_212_191/0.16),transparent_50%)]"
      />

      <div className="relative sm:aspect-square">
        {/* The orbit. Decorative: the list below is what says who is on it. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 hidden h-full w-full sm:block"
        >
          <ellipse
            cx="50"
            cy="50"
            rx="30"
            ry="38"
            fill="none"
            stroke="rgb(186 230 253 / 0.35)"
            strokeWidth="0.4"
            strokeDasharray="1.2 1.6"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        <div
          aria-hidden="true"
          className="about-globe relative mx-auto aspect-square w-40 sm:absolute sm:left-1/2 sm:top-1/2 sm:w-[40%] sm:-translate-x-1/2 sm:-translate-y-1/2"
        >
          <div className="about-globe__map">
            {/* Twice, side by side: see about-globe.css for why. */}
            <img src={earthUrl} alt="" width={1024} height={512} loading="lazy" decoding="async" />
            <img src={earthUrl} alt="" width={1024} height={512} loading="lazy" decoding="async" />
          </div>
          <div className="about-globe__shade" />
        </div>

        <ul
          aria-label={t('about.media.label')}
          className="mt-5 grid grid-cols-2 gap-2 sm:absolute sm:inset-0 sm:mt-0 sm:block"
        >
          {roles.map((role, index) => {
            const { x, y } = orbitPosition(index, roles.length);
            return (
              <li
                key={role}
                style={{ '--about-x': `${String(x)}%`, '--about-y': `${String(y)}%` } as React.CSSProperties}
                className="flex items-center justify-center rounded-full bg-navy-hover px-3 py-1.5 text-center text-xs font-medium leading-snug text-white ring-1 ring-inset ring-sky-200/30 sm:absolute sm:left-[var(--about-x)] sm:top-[var(--about-y)] sm:max-w-[8.5rem] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:shadow-lg sm:shadow-black/30"
              >
                {t(roleKey(role))}
              </li>
            );
          })}
        </ul>
      </div>

      <figcaption className="relative mt-5 text-center text-sm leading-relaxed text-white/80">
        {t('about.media.caption')}
      </figcaption>
    </figure>
  );
}
