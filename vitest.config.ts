import { defineConfig } from 'vitest/config'

// Deliberately NOT extending vite.config.ts: the TanStack Start and Nitro
// plugins build a server bundle, which has nothing to do with running tests
// and breaks the edge-runtime environment convex-test needs.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    // convex-test runs Convex functions in a V8-isolate-like environment;
    // `edge-runtime` is the closest match to the Convex default runtime.
    environment: 'edge-runtime',
    include: ['src/**/*.test.ts', 'convex/**/*.test.ts'],
    server: { deps: { inline: ['convex-test'] } },
    // `pnpm test:coverage`. A report, not a gate: no threshold until the
    // numbers have been read once and a floor chosen on purpose.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'convex/**/*.ts'],
      exclude: ['**/*.test.ts', 'convex/_generated/**', 'src/routeTree.gen.ts'],
      reporter: ['text-summary', 'html'],
    },
  },
})
