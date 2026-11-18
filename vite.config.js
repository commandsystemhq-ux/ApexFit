import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
});
