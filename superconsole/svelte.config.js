import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  // script:true so esbuild strips TS that Svelte 5's native stripper leaves
  // behind (e.g. `value?: string` → invalid `value?` during Vite SSR).
  preprocess: vitePreprocess({ script: true }),
  kit: {
    adapter: adapter({
      out: 'build',
      precompress: true,
    }),
  },
};

export default config;
