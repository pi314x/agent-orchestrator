import { defineConfig } from 'vitest/config';

export const config = defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true
  }
});

export default config;
