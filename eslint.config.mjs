// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', '*.config.*'] },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    plugins: { unicorn },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      'no-duplicate-imports': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['error', 'log', 'warn'] }],
      'prefer-const': 'error',
      'no-var': 'error',

      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
      'unicorn/prefer-node-protocol': 'error',
    },
  },

  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);
