import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'dist/**',
      'output/**',
      'data/**',
      'public/data/**',
      'services/mrms-rs/target/**'
    ]
  },
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin
    },
    rules: {}
  }
];
