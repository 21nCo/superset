import {
  createBaseLayoutOptions,
  type DocsGitConfig,
} from "@superfunctions/docs-theme";

export const gitConfig: DocsGitConfig = {
  user: "21nCo",
  repo: "super-functions",
  branch: "dev",
};

export function baseOptions() {
  return createBaseLayoutOptions("SearchFn", gitConfig);
}
