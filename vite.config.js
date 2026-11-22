import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { devFoodSearch } from './scripts/vite-dev-food-search.mjs';

export default defineConfig(({ mode }) => {
  // Server-side settings such as USDA_API_KEY are read here for the dev server only; they never reach the browser bundle.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), devFoodSearch({ usdaKey: env.USDA_API_KEY || '' })],
    build: {
      // The translated exercise steps (about 650 kB per language) are loaded on demand, one language at a time, so only the language in use is downloaded.
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          // The five-language dictionaries are large and change rarely, so they get their own cacheable chunk.
          manualChunks(id) {
            const path = id.replace(/\\/g, '/');
            if (path.includes('/src/i18n/')) return 'i18n';
            return undefined;
          },
        },
      },
    },
  };
});