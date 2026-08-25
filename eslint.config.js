import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['src/__tests__/auto-tag-workflow.test.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.workflow-tests.json',
        projectService: false,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: [
      '.github/scripts/resolve-conflicts-contract.mjs',
      'src/__tests__/pr-comment-commands-workflow.test.ts',
      'src/__tests__/resolve-conflicts-contract.test.ts',
    ],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        process: 'readonly',
      },
      parserOptions: {
        project: './tsconfig.resolve-contracts.json',
        projectService: false,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: [
      'dist/',
      'node_modules/',
      '*.config.js',
      'src/__tests__/**/*',
      '!src/__tests__/auto-tag-workflow.test.ts',
      '!src/__tests__/pr-comment-commands-workflow.test.ts',
      '!src/__tests__/resolve-conflicts-contract.test.ts',
    ],
  }
);
