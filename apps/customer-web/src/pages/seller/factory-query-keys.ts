/**
 * React Query keys for a seller's factories and certifications, shared by the
 * factories page and its dialogs.
 *
 * Kept out of `FactoryDialogs.tsx` so that file exports only components,
 * which React Fast Refresh needs to keep state across an edit.
 */
export const FACTORIES_KEY = ['seller', 'factories'] as const;
export const CERTIFICATIONS_KEY = ['seller', 'certifications'] as const;
