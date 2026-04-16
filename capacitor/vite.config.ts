import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    react(),
    // Copy ArcGIS assets (fonts, images, workers) into the build output
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@arcgis/core/assets',
          dest: '.',
        },
      ],
    }),
  ],
  server: {
    proxy: {
      '/tpk-proxy': {
        target: 'https://tpk.allma.no',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tpk-proxy/, ''),
      },
    },
  },
  build: {
    // ArcGIS chunks are large — raise the warning threshold
    chunkSizeWarningLimit: 4000,
  },
});
