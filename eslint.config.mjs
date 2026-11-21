// ESLint flat config. Run with `npm run lint` (CI runs the same command).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'media/vendor/**', 'eval/**', '.e2e/**', 'installer/**', 'installer-mac/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // The codebase talks to untyped JSON (LLM responses, MCP, webview messages) in many places.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      // BOMs and zero-width characters are matched on purpose by the text extractors.
      'no-irregular-whitespace': ['error', { skipStrings: true, skipRegExps: true, skipTemplates: true, skipComments: true }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': ['warn', { ignoreReadBeforeAssign: true }],
    },
  },
  {
    // Browser-side webview scripts and Node build scripts are plain JavaScript.
    files: ['media/**/*.js', 'scripts/**/*.js', 'src/test/fixtures/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly', acquireVsCodeApi: 'readonly',
        console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', requestAnimationFrame: 'readonly', getComputedStyle: 'readonly',
        require: 'readonly', module: 'writable', process: 'readonly', __dirname: 'readonly', Buffer: 'readonly',
        URL: 'readonly', MutationObserver: 'readonly', ResizeObserver: 'readonly', IntersectionObserver: 'readonly',
        HTMLElement: 'readonly', Node: 'readonly', Event: 'readonly', KeyboardEvent: 'readonly', localStorage: 'readonly',
        location: 'readonly', fetch: 'readonly', Blob: 'readonly', FileReader: 'readonly', performance: 'readonly',
        mermaid: 'readonly', queueMicrotask: 'readonly', structuredClone: 'readonly', CSS: 'readonly',
        MouseEvent: 'readonly', WheelEvent: 'readonly', Image: 'readonly', innerWidth: 'readonly', innerHeight: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
    },
  },
);
