import { defineConfig } from 'vite';
import { aliases } from './aliases';
export default defineConfig({ define: { __UIFN_DEV_TRACE__: "false" }, resolve: { alias: aliases }, server: { port: 4177 } });
