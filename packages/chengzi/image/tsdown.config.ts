import { defineConfig } from 'tsdown'

/**
 * Node-only host plugin: a single entry bundling the tsc-emitted tree into the
 * loader-facing `lib/index.js` (same shape as the official host plugins, e.g.
 * `packages/host/open-in-app`).
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
