import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.tmp/**',
      '.next/**',
      'node_modules/**',
      'dist/**',
      'output/**',
      'data/**',
      'public/data/**',
      'public/service-worker.js',
      'public/approach_viz_core.js',
      'services/runtime-rs/target/**',
      'packages/approach-viz-core-wasm/**'
    ]
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ]
    }
  }
);
