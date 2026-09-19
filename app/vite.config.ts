/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * webOS loads a sideloaded app from file://, where the page's origin is
 * `null`. Chromium refuses `<script type="module">` (and anything carrying
 * `crossorigin`) from a null origin on CORS grounds, which shows up on the TV
 * as a blank black screen. So the bundle is built as a single IIFE and the
 * tags are rewritten into a classic deferred script.
 */
function classicScripts(): Plugin {
  return {
    name: 'naktv-classic-scripts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html
          .replace(/<script type="module" crossorigin /g, '<script defer ')
          .replace(/ crossorigin(?=[ >])/g, ''),
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths, because the app is served from a file:// directory.
  base: './',
  plugins: [react(), classicScripts()],
  build: {
    // webOS 23 (the LG B3) runs Chromium 108 — read off the TV's user agent,
    // not the spec sheet. Syntax is lowered to match; newer APIs are not
    // polyfilled, so check caniuse before reaching for anything recent.
    target: 'chrome108',
    modulePreload: false,
    cssCodeSplit: false,
    rolldownOptions: {
      output: { format: 'iife', inlineDynamicImports: true },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
      thresholds: { lines: 70 },
    },
  },
});
