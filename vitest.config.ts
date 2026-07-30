import { defineConfig } from 'vitest/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
    environment: 'node',
  },
  resolve: {
    // Mirror tsconfig "@/*": ["./*"]. Regex so it only rewrites bare "@/..."
    // and never touches scoped packages like "@upstash/redis".
    alias: [{ find: /^@\//, replacement: `${root}/` }],
  },
});
