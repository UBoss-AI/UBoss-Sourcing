/**
 * The "I accept the terms" tick, with this deployment's policy links beside it.
 *
 * The markup lives in `components/ui/auth-form.tsx` as `AuthTermsCheckbox`,
 * byte-identical in all three apps, because the sign-in screens of the
 * storefront, the admin panel and the logistics portal ask for the same
 * consent and it has to read identically on every one of them. Before that it
 * was this component in the storefront and the same markup inlined in the
 * admin panel with `text-accent` where this had `text-brand` — two copies, one
 * of them already drifting.
 *
 * What is left here is the one thing that genuinely differs per app: where the
 * policy links come from. The storefront reads them off the storefront config;
 * the admin panel and the portal each fetch their own. So this is a wrapper of
 * three lines, and the three screens below it are the same screen.
 *
 * Three call sites — sign-in, registration and invitation activation — and the
 * box is never ticked for the customer at any of them. A pre-ticked consent is
 * not consent, and every `defaultValues` says `false`.
 */
import { forwardRef } from 'react';
import { AuthTermsCheckbox } from '@/components/ui/auth-form';
import type { AuthTermsCheckboxProps } from '@/components/ui/auth-form';
import { useStorefront } from '@/app/storefront-context';

export type AcceptTermsCheckboxProps = Omit<AuthTermsCheckboxProps, 'policies'>;

export const AcceptTermsCheckbox = forwardRef<HTMLInputElement, AcceptTermsCheckboxProps>(
  function AcceptTermsCheckbox(props, ref) {
    const { business } = useStorefront();

    return (
      <AuthTermsCheckbox
        ref={ref}
        policies={Object.entries(business.policyLinks ?? {})}
        {...props}
      />
    );
  },
);
