import path from 'node:path';
import { defineConfig } from 'vitest/config';

const reactRoot = path.resolve(__dirname, '../../node_modules');

export default defineConfig({
  resolve: {
    alias: {
      react: path.join(reactRoot, 'react'),
      'react-dom': path.join(reactRoot, 'react-dom'),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'node',
    server: {
      deps: {
        inline: [/@uifn\/react/],
      },
    },
  },
});
