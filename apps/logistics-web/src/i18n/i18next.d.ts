/**
 * Type-checks every translation key against the English catalogue.
 *
 * This is what keeps the safety the hand-rolled engine had: `t('auth.lgoin.heading')`
 * is a compile error, not a raw key rendered to a customer. It also gives the
 * editor autocomplete over the whole catalogue, which is the difference
 * between looking a key up and remembering one.
 *
 * `keySeparator: false` has to be declared here as well as in the runtime
 * config. Without it TypeScript reads the dots in our flat keys as a path into
 * a nested object and resolves every key to `never`.
 */
import type en from './locales/en.json';
import type { NAMESPACE } from './config';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof NAMESPACE;
    resources: {
      app: typeof en;
    };
    keySeparator: false;
    nsSeparator: false;

    // Without these, `t` is typed as a union of "plain string" and i18next's
    // detailed-result object, and TypeScript stops narrowing it once the key
    // union gets large - which turns every `{t(someKey)}` in JSX into a type
    // error about ReactNode. We never ask for either behaviour.
    returnNull: false;
    returnObjects: false;
  }
}
