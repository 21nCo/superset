import { defineConfig } from 'vitest/config';
import { aliases } from './aliases';
export default defineConfig({ define: { __UIFN_DEV_TRACE__: "false" }, resolve: { alias: aliases }, test: { environment: 'node' } });
