import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// ESLint 9 flat config. Lints the TypeScript API source.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // `ignoreRestSiblings` is what makes `const { key: _omitted, ...rest } = obj` legal —
      // the idiomatic way to build an object minus one field, used in the DTO tests to prove
      // a required key is required.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  // Plain-JS maintenance scripts run under Node directly. typescript-eslint switches
  // `no-undef` off for .ts files because the compiler already checks names, so these are the
  // only files where the rule fires — and it needs to be told which globals Node provides.
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
);
