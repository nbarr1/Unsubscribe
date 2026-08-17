import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // `x == null` is the idiomatic "null or undefined" check, and SQLite
      // hands back nulls where TypeScript expects `T | null`. Everything else
      // must be strict.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
);
