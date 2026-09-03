import js from '@eslint/js';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
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
      // A public storefront has to work for everyone. These rules catch the
      // failures that are invisible to a sighted mouse user: an image with no
      // alt, a click handler on a div, a label with nothing to label.
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Radio and checkbox cards wrap their own input and put the label text
      // inside nested spans for layout. That is valid and accessible; the
      // rule's default only looks two elements deep.
      'jsx-a11y/label-has-associated-control': ['error', { depth: 4 }],
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // A promise dropped in a click handler swallows its error.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      // react-hook-form types a field path with a numeric index, so the index
      // must stay a number inside the template - String(index) widens it to
      // plain string and it no longer matches the Path union.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Tests assert on things the strict rules would flag as unnecessary.
    files: ['**/*.test.{ts,tsx}', 'src/test/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
