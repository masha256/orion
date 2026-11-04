import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Checks ORION_TEST_DATABASE_URL and the server, and sweeps stale t_* schemas (tests/setup/pgGlobal.ts).
    globalSetup: ['tests/setup/pgGlobal.ts'],
    hookTimeout: 30_000,
  },
});
