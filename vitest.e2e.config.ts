import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

/** 前端自动化测试：启动真实 Electron，串行跑，不进 `pnpm test`。 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(root, 'src/shared'),
      '@': path.resolve(root, 'src/renderer'),
      '@enso/pair': path.resolve(root, 'packages/pair/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['e2e/**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
