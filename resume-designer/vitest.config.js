import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Unit tests for pure renderer logic. jsdom gives us `window`/`document`
// (DOMPurify needs a DOM) and a `localStorage` implementation (the backup
// import functions read/write it). Tests live in test/ and import the real
// modules from src/.
export default defineConfig({
  // Mirrors vite.config.js and jsconfig.json. Without it, ANY module that
  // reaches a `@/`-importing file is untestable — and transitively so: a test
  // could import a plain src/*.js module and still fail on an `@/` import three
  // hops down (src/backupFlow.js -> components/ui/confirm.jsx ->
  // '@/components/ui/alert-dialog'). Keep in sync with vite.config.js.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.js'],
    clearMocks: true,
  },
});
