import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tsconfigPaths from 'vite-tsconfig-paths'

const normalizeFilePath = (value: string) => value.replace(/\\/g, '/');

const isIgnoredDevWatchPath = (filePath: string): boolean => {
  const normalizedPath = normalizeFilePath(filePath);
  return (
    normalizedPath.includes('/_api/')
    || normalizedPath.includes('/_sync/')
    || normalizedPath.includes('/server/')
    || normalizedPath.includes('/_server/')
    || normalizedPath.endsWith('/src/_sockets/apiTypes.generated.ts')
    || normalizedPath.endsWith('/src/docs/apiDocs.generated.json')
  );
};

export default defineConfig(({ command }) => {
  const isProduction = command === 'build';

  return {
    base: '/',
    plugins: [
      react(),
      tsconfigPaths({
        projects: ['tsconfig.app.json', 'tsconfig.server.json'],
      }),
    ],
    build: {
      rollupOptions: {
        // Only apply heavy external filtering during the production build
        external: isProduction ? (id) => {
          const ignored = [/\/_api\//, /\/_sync\//, /\/server\//, /\/_server\//];
          return ignored.some(pattern => pattern.test(id));
        } : [],
      },
      target: 'esnext',
    },
    resolve: {},
    // Define a global constant so your main.tsx knows if it's building for prod
    define: {
      __IS_PROD__: isProduction,
    },
    server: {
      watch: {
        usePolling: true,
        ignored: isIgnoredDevWatchPath,
      },
    }
  }
})