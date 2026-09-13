import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export const mcpfnTestingVersionDefine = {
  __MCPFN_TESTING_VERSION__: JSON.stringify(packageJson.version),
};
