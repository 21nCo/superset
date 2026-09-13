import type { LayoutServerLoad } from "./$types";

// Full manifests and search artifacts stay in server-only route loaders.
export const load: LayoutServerLoad = async () => ({});
