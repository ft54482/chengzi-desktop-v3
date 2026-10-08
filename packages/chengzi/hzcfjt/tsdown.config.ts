import { defineConfig } from 'tsdown'

/**
 * Node-only host plugin: a single entry bundling the tsc-emitted tree into the
 * loader-facing `lib/index.js` (same shape as the official host plugins, e.g.
 * `packages/host/open-in-app`). The customer-approved head asset
 * (`assets/hzcfjt-head.pptx`) is NOT a bundler import: `src/pptx/head.ts`
 * reads it from disk at runtime by walking up from the module directory, so
 * the binary never crosses the bundle boundary.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
