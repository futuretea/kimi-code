import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'oca-facade',
    include: ['test/**/*.test.ts'],
  },
});
