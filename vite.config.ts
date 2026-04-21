import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';

function generateModelCatalog() {
  execFileSync(process.execPath, ['scripts/generate-model-catalog.mjs'], {
    stdio: 'inherit',
  });
}

export default defineConfig({
  plugins: [
    {
      name: 'generate-model-catalog',
      buildStart() {
        generateModelCatalog();
      },
      configureServer(server) {
        const modelsGlob = 'public/models/**/*';
        server.watcher.add(modelsGlob);
        server.watcher.on('add', (filePath) => {
          if (filePath.includes('/public/models/')) {
            generateModelCatalog();
          }
        });
        server.watcher.on('unlink', (filePath) => {
          if (filePath.includes('/public/models/')) {
            generateModelCatalog();
          }
        });
      },
    },
    react(),
  ],
});
