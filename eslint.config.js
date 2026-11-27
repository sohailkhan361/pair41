// ESLint configuration (flat config). Plain JavaScript is allowed here: it is tool config, not app code.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'coverage/', 'data/', 'agent-kit/plugin/pair41/lib/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    // The pages' own script runs in the browser.
    files: ['src/server/web/static/*.js', 'src/server/web/static/space/*.js'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly' } },
  },
);
