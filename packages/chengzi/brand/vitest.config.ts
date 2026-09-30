import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// Mirrors the repository root vitest.config.ts resolution face: tests resolve
// workspace imports through tsconfig.base.json paths (source-level), so the
// suite can run both from the package (`pnpm --filter … test`) and the root.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.{ts,tsx}'],
  },
  plugins: [tsconfigPaths({ projects: ['../../../tsconfig.base.json'] })],
})
