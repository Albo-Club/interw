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
  },
})
