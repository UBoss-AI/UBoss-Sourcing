import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'prisma/migrations/**',
      // Prisma generates this; it is not ours to lint.
      'src/generated/**',
      // This config file itself is outside the TS project service.
      'eslint.config.js',
      /*
       * Throwaway scripts somebody ran once against their own database.
       *
       * They are gitignored (see `.gitignore`), so they never reach CI and
       * never reach a release - but `eslint .` still found them on the
       * developer's machine and failed `npm run verify` on `no-console`, in a
       * file that is nothing to do with whatever change was being verified. A
       * verify that fails for a reason unrelated to the work is a verify people
       * learn to skip.
       *
       * The `.dev.ts` suffix is the contract: name a scratch script that way
       * and it is ignored by both git and the linter.
       */
      '**/*.dev.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Money and business-rule safety: `any` erodes every invariant in this codebase.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Never let a raw float sneak into a money path.
      'no-restricted-globals': ['error', { name: 'parseFloat', message: 'Money is BIGINT minor units; use domain/money helpers.' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // CLI scripts: console output is their user interface, not a stray log.
    files: [
      'tests/**/*.ts',
      'src/seed/**/*.ts',
      'scripts/**/*.ts',
      'src/http/openapi-export.ts',
      '**/*.cli.ts',
      '**/*.test.ts',
    ],
    rules: { 'no-console': 'off', '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
);
