/**
 * The Support page's frame: heading, contact channels with the globe under
 * them, and the form card beside them.
 *
 * The approved reference `ContactWithGlobe`, with its layout, motion and globe
 * kept. What changed, and why:
 *
 *   - **The content is passed in.** The reference hard-coded an email, a phone
 *     number, "ScrollX UI" and a form that sent nothing. Here the contacts come
 *     from the operator's settings, every sentence from the translation
 *     catalogue, and the card holds whatever form the caller renders - the
 *     real, submitting one.
 *   - **Brand tokens, not zinc and rose.** Every colour is one of this app's
 *     theme variables, so light and dark both follow the storefront's own
 *     palette and its contrast checks, and the accent is the brand blue.
 *   - **A page heading when it is the page.** `titleAs="h1"` makes the title the
 *     page's h1 and marks it for the layout's focus-on-navigate; the section
 *     headings under it step down to h2.
 *   - **Motion respects the reader.** With reduced motion asked for, every
 *     element starts where it ends: nothing slides in.
 *   - **No second Button or separator library.** `FormDots` keeps the dotted
 *     rule but is a plain decorative element rather than a Radix Separator, so
 *     no new dependency; lucide icons are replaced with this app's own.
 *   - `bg-linear-to-t` is Tailwind 4; on 3.4 it is `bg-gradient-to-t`.
 *   - **A slot under the heading.** `lead` renders between the introduction
 *     and the contact grid - where the Support page puts its FAQ, so a common
 *     question is answered before anybody is asked to write in.
 */
import type { ComponentType, ReactNode } from 'react';
import { motion } from 'motion/react';
import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';
import { GlobeWireframe } from './GlobeWireframe';

const smoothEase = [0.25, 0.1, 0.25, 1] as const;

export interface ContactChannel {
  icon: ComponentType<{ className?: string }>;
  /** What the row says - the address or number itself. */
  label: string;
  /** What a screen reader hears before it, e.g. "Email". */
  kind: string;
  href: string;
}

/** A dotted rule, faded at both ends. Decorative. */
export function FormDots({ className }: { className?: string }): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cx('flex w-full shrink-0 items-center justify-center overflow-hidden', className)}
    >
      <div className="relative h-4 w-full">
        <div
          className="absolute inset-0 bg-repeat text-ink-subtle/60"
          style={{
            backgroundImage: 'radial-gradient(circle, currentColor 0.8px, transparent 0.8px)',
            backgroundSize: '6px 100%',
            maskImage:
              'linear-gradient(to right, transparent 0%, black 10%, black 90%, transparent 100%)',
          }}
        />
      </div>
    </div>
  );
}

export interface ContactWithGlobeProps {
  title: string;
  subtitle: string;
  description: string;
  getInTouchTitle: string;
  getInTouchBody: string;
  channels: ContactChannel[];
  /** Shown instead of the channel list when the operator has published none. */
  noChannelsMessage: string;
  formTitle: string;
  formDescription?: string;
  /** The card's body: the form, a sign-in prompt, or a confirmation. */
  children: ReactNode;
  /** Content between the introduction and the contact grid. */
  lead?: ReactNode;
  /**
   * An id for the card, so a link elsewhere on the page can bring it into
   * view. Its heading gets `${formId}-heading` and can take focus.
   */
  formId?: string;
  titleAs?: 'h1' | 'h2';
  className?: string;
}

export function ContactWithGlobe({
  title,
  subtitle,
  description,
  getInTouchTitle,
  getInTouchBody,
  channels,
  noChannelsMessage,
  formTitle,
  formDescription,
  children,
  lead,
  formId,
  titleAs = 'h2',
  className,
}: ContactWithGlobeProps): React.JSX.Element {
  const still = usePrefersReducedMotion();
  const Title = titleAs === 'h1' ? motion.h1 : motion.h2;
  const Sub = titleAs === 'h1' ? 'h2' : 'h3';

  /** Where each element starts. With reduced motion asked for, where it ends. */
  const from = (shift: { x?: number; y?: number }) => (still ? false : { opacity: 0, ...shift });

  return (
    <section className={cx('relative w-full overflow-hidden py-12 sm:py-20', className)}>
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mb-10 flex flex-col items-center gap-4 text-center sm:mb-12">
          <motion.div
            initial={from({ y: -12 })}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, ease: smoothEase }}
            className="inline-flex items-center rounded-full border border-brand/30 bg-brand-soft px-4 py-1.5"
          >
            <span className="text-sm font-medium text-brand">{subtitle}</span>
          </motion.div>

          <Title
            {...(titleAs === 'h1' ? { 'data-route-focus': true, tabIndex: -1 } : {})}
            initial={from({ y: 14 })}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.9, delay: 0.15, ease: smoothEase }}
            className="text-4xl font-bold text-ink focus:outline-none md:text-5xl lg:text-6xl"
          >
            {title}
          </Title>

          <motion.p
            initial={from({ y: 14 })}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.9, delay: 0.3, ease: smoothEase }}
            className="max-w-md text-base text-ink-muted"
          >
            {description}
          </motion.p>
        </div>

        {lead !== undefined && (
          <div className="mx-auto mb-12 max-w-4xl border-b border-border pb-12 sm:mb-16 sm:pb-16">
            {lead}
          </div>
        )}

        <div className="mx-auto grid max-w-5xl grid-cols-1 items-start gap-10 lg:grid-cols-2">
          <motion.div
            initial={from({ y: 28 })}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 1.0, delay: 0.2, ease: smoothEase }}
            className="flex min-w-0 flex-col gap-6"
          >
            <div className="flex flex-col gap-1">
              <Sub className="text-xl font-semibold text-ink">{getInTouchTitle}</Sub>
              <p className="max-w-xs text-sm leading-relaxed text-ink-muted">{getInTouchBody}</p>
            </div>

            {channels.length === 0 ? (
              <p className="max-w-xs rounded-lg border border-border bg-surface px-4 py-3 text-sm text-ink-muted">
                {noChannelsMessage}
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {channels.map(({ icon: Icon, label, kind, href }, i) => (
                  <motion.li
                    key={href}
                    initial={from({ x: -12 })}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: 0.3 + i * 0.1, ease: smoothEase }}
                  >
                    <a
                      href={href}
                      className="group flex w-fit max-w-full items-center gap-3 rounded-md text-sm text-ink-muted transition-colors duration-200 hover:text-ink"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface transition-all duration-200 group-hover:border-brand/40 group-hover:bg-brand-soft">
                        <Icon className="h-3.5 w-3.5 text-ink-subtle transition-colors duration-200 group-hover:text-brand" />
                      </span>
                      <span className="sr-only">{kind}: </span>
                      <span className="break-all">{label}</span>
                    </a>
                  </motion.li>
                ))}
              </ul>
            )}

            <div className="relative h-52 overflow-hidden text-brand">
              <GlobeWireframe
                className="absolute left-0 top-0 aspect-square w-full max-w-full"
                variant="wireframesolid"
                autoRotate
                autoRotateSpeed={0.45}
                strokeWidth={0.6}
                graticuleOpacity={0.12}
              />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-surface-sunken to-transparent" />
            </div>
          </motion.div>

          <motion.div
            initial={from({ y: 28 })}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 1.0, delay: 0.35, ease: smoothEase }}
            id={formId}
            // scroll-mt-12, not less: a card brought into view before it has
            // slid in is measured 28px low, and would end under the header.
            className="flex min-w-0 scroll-mt-12 flex-col gap-5 rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-8"
          >
            <div>
              <Sub
                {...(formId !== undefined ? { id: `${formId}-heading`, tabIndex: -1 } : {})}
                className="mb-0.5 text-lg font-semibold text-ink focus:outline-none"
              >
                {formTitle}
              </Sub>
              {formDescription !== undefined && (
                <p className="text-sm text-ink-muted">{formDescription}</p>
              )}
            </div>

            <FormDots />

            {children}
          </motion.div>
        </div>
      </div>
    </section>
  );
}
