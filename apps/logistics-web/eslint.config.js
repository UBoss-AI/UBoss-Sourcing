import js from '@eslint/js';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      // The storefront has had this since it was written; the console had not.
      // The European Accessibility Act does not reach an internal tool, but
      // the people running the shop are as likely to use a screen reader as
      // the people buying from it, and an unlabelled icon button is exactly as
      // unusable on this side of the login.
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Several controls here wrap their own input and put the label text in
      // nested spans for layout. That is valid and accessible; the rule's
      // default only looks two elements deep.
      'jsx-a11y/label-has-associated-control': ['error', { depth: 4 }],
      // A horizontally scrollable table needs tabIndex={0}, and the rule does
      // not know it.
      //
      // A box that scrolls sideways and cannot be focused is unreachable
      // without a mouse - WCAG 2.1.1 - so every wide table in this panel is a
      // `role="region"` with an aria-label and tabIndex={0}, which is the
      // pattern the WAI recommends for exactly this. The default rule allows
      // that only for `tabpanel`, so `region` is added rather than the
      // occurrences being disabled one by one: a per-line disable is a per-line
      // invitation to add an unlabelled focusable div next to it.
      'jsx-a11y/no-noninteractive-tabindex': [
        'error',
        { tags: [], roles: ['tabpanel', 'region'], allowExpressionValues: true },
      ],
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // A promise dropped on the floor in a click handler swallows its error.
      '@typescript-eslint/no-floating-promises': 'error',
      // react-hook-form types a field path with a numeric index, so the index
      // must stay a number inside the template - String(index) widens it to
      // plain string and it no longer matches the Path union. A number is the
      // one type that stringifies unambiguously, so allowing it costs nothing.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
);
