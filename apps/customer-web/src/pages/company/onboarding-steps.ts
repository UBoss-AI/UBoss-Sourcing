/**
 * The company onboarding steps, in order.
 *
 * Kept out of `OnboardingSteps.tsx` so that file exports only its component,
 * which React Fast Refresh needs to keep state across an edit.
 */
export const ONBOARDING_STEPS = [
  'applicant',
  'business',
  'identifiers',
  'addresses',
  'documents',
  'review',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
