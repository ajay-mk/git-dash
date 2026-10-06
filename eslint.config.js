import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Guard rails for a public, security-sensitive client app.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Do not render raw HTML; API data must be rendered as text.',
        },
        {
          selector: "AssignmentExpression[left.property.name='innerHTML']",
          message: 'Do not assign innerHTML; API data must be rendered as text.',
        },
      ],
    },
  },
  {
    // Tests deliberately feed malicious URLs to the sanitisers.
    files: ['**/*.test.ts'],
    rules: { 'no-script-url': 'off' },
  },
);
