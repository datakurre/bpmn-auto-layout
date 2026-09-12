// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '*.config.*'],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    plugins: { unicorn },
    rules: {
      // Keep code lean and prevent bloated, deeply nested functions
      complexity: ['error', { max: 15 }],
      'max-depth': ['error', { max: 4 }],
      'max-nested-callbacks': ['error', { max: 3 }],
      'max-params': ['error', { max: 3 }],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
      'max-statements-per-line': ['error', { max: 1 }],

      // Eliminate unnecessary boilerplate, dead paths, and redundant syntax
      'no-else-return': ['error', { allowElseIf: false }],
      'no-lonely-if': 'error',
      'no-useless-return': 'error',
      'no-useless-rename': 'error',
      'no-useless-concat': 'error',
      'no-useless-constructor': 'error',
      'no-unneeded-ternary': ['error', { defaultAssignment: false }],
      'object-shorthand': ['error', 'always'],
      'prefer-template': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-duplicate-imports': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
      'no-console': ['error', { allow: ['error', 'warn', 'log'] }],

      // TypeScript agent guardrails
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-expressions': 'error',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      // bpmn-js APIs are largely untyped; `any` is unavoidable at the boundary.
      '@typescript-eslint/no-explicit-any': 'off',

      // Unicorn rules for modern, concise, and clean JavaScript/TypeScript
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
      'unicorn/no-useless-spread': 'error',
      'unicorn/no-useless-fallback-in-spread': 'error',
      'unicorn/no-useless-length-check': 'error',
      'unicorn/no-useless-promise-resolve-reject': 'error',
      'unicorn/prefer-array-find': 'error',
      'unicorn/prefer-array-some': 'error',
      'unicorn/prefer-includes': 'error',
      'unicorn/prefer-string-starts-ends-with': 'error',
      'unicorn/prefer-default-parameters': 'error',
      'unicorn/prefer-optional-catch-binding': 'error',
      'unicorn/no-unnecessary-await': 'error',
      'unicorn/consistent-function-scoping': 'error',
      'unicorn/no-typeof-undefined': 'error',
      'unicorn/prefer-ternary': ['error', 'only-single-line'],
      'unicorn/prefer-logical-operator-over-ternary': 'error',
      'unicorn/prefer-export-from': 'error',
    },
  },

  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'max-lines-per-function': 'off',
    },
  }
);
