import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import ensobotRelease from './ensobot-release.json';
import pkg from './package.json';
import { productFor } from './src/shared/product';

const product = productFor(process.env.ENSO_PRODUCT);
const productDefine = { __ENSO_PRODUCT__: JSON.stringify(process.env.ENSO_PRODUCT ?? 'ensocode') };

// 合并说明：dev 曾为手工 multi-input 显式复刻默认 external（nodeExternal）。
// 本分支已改用 `?modulePath` 独立构建 agent worker、main 保持官方单入口，
// 默认 external 自然生效，nodeExternal 随之成为死代码，故一并移除。

// @enso/pair 是 workspace 内的 TS 源码包，需被打进产物（不可 external），
// 三段统一用 alias 指到源码入口。
const pairAlias = path.resolve(__dirname, 'packages/pair/src/index.ts');

export default defineConfig({
  main: {
    define: productDefine,
    build: {
      // Agent utilityProcess 走 `?modulePath` isolated build；Main 保持官方单入口，
      // 避免手工 multi-input 把无 export 的启动入口 tree-shake 成 0B facade。
      externalizeDeps: true,
      rollupOptions: {
        // externalizeDeps 只认 dependencies；node-llama-cpp 在 optionalDependencies 里，
        // 被打进 bundle 后它对 .node 绑定的动态 require 会失效。
        external: ['node-llama-cpp'],
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
        '@enso/pair': pairAlias,
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    define: {
      ...productDefine,
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(
        product.slug === 'ensobot' ? ensobotRelease.version : pkg.version
      ),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer'),
        '@shared': path.resolve(__dirname, 'src/shared'),
        '@enso/pair': pairAlias,
      },
    },
    // diff 高亮 worker（@pierre/diffs）含动态 import，iife 格式打不了，需 es
    worker: { format: 'es' },
    build: {
      // electron-vite renderer 默认 minify:false，未压缩的 mermaid/shiki chunk 有十几 MB
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html'),
          settings: path.resolve(__dirname, 'src/renderer/settings.html'),
          ensobot: path.resolve(__dirname, 'src/renderer/ensobot.html'),
        },
      },
    },
  },
});
