import path from 'node:path';

// Use the same public sources for local preview and tests without rebuilding the monorepo.
export const aliases = [
  { find: '@uifn/registry/preset', replacement: path.resolve(__dirname, '../registry/src/preset/index.ts') },
  { find: /^@uifn\/components-react\/(.+)$/, replacement: path.resolve(__dirname, '../components-react/src/generated/$1.ts') },
  { find: /^@uifn\/react\/(.+)$/, replacement: path.resolve(__dirname, '../react/src/generated/$1.tsx') },
  { find: '@uifn/recipes/component', replacement: path.resolve(__dirname, '../recipes/src/component.ts') },
  { find: '@uifn/components/styles.css', replacement: path.resolve(__dirname, '../components/styles.css') },
  { find: /^@uifn\/core\/primitives$/, replacement: path.resolve(__dirname, '../core/src/primitives/index.ts') },
  { find: /^@uifn\/core\/primitives\/.+$/, replacement: path.resolve(__dirname, '../core/src/primitives/index.ts') },
  { find: /^@uifn\/core\/(.+)$/, replacement: path.resolve(__dirname, '../core/src/$1.ts') },
  ...['core', 'dom', 'adapter-kit'].map(name => ({ find: new RegExp(`^@uifn/${name}$`), replacement: path.resolve(__dirname, `../${name}/src/index.ts`) })),
];
