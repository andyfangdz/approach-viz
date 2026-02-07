import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    port: 3000,
    host: true
  },
  preview: {
    port: 3001,
    host: true,
    allowedHosts: ['oci-useast-arm-4.pigeon-justice.ts.net', 'localhost']
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
});
