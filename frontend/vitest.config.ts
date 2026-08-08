import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/components/AvatarView/Live2DAdapter.test.ts',
      'src/components/MvpRoom/**/*.{test,spec}.{ts,tsx}',
      'src/lib/__tests__/reverieChatStorage.test.ts',
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/lib/llmClient.ts'],
      thresholds: {
        lines: 75,
        functions: 85,
        branches: 70,
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
