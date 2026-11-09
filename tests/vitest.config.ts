import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['api/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Files run one at a time: several of them measure the API process or
    // restart it, and must not do that under each other's feet.
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
