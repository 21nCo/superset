import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAction } from "../src/runner.js";
import { runCacFixture } from "./fixtures/cac/index.js";
import { runCommanderFixture } from "./fixtures/commander/index.js";
import { runParseArgsFixture } from "./fixtures/parse-args/index.js";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
const repoRootPath = fileURLToPath(new URL("../../..", import.meta.url));

describe("readme examples", () => {
  it("keeps the quick-start runner example executable", async () => {
    const stdout: string[] = [];

    const exitCode = await runAction(
      async ({ name }, ctx) => {
        ctx.output.info(`hello ${name}`);
      },
      { name: "world" },
      {
        color: false,
        stdout: (text) => stdout.push(text),
      }
    );

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toBe("[i] hello world\n");
  });

  it("keeps the README parser examples aligned with executable canaries", async () => {
    await expect(runCommanderFixture(["--verbose", "greet", "--name", "Ada"])).resolves.toEqual({
      exitCode: 0,
      stdout: "[d] parser commander\n[i] hello Ada from commander\n",
      stderr: "",
    });

    await expect(runCacFixture(["greet", "--name", "Grace", "--json"])).resolves.toEqual({
      exitCode: 0,
      stdout: '{"ok":true,"parser":"cac","name":"Grace"}\n',
      stderr: "",
    });

    await expect(runParseArgsFixture(["greet", "--name", "Linus"])).resolves.toEqual({
      exitCode: 0,
      stdout: "[i] hello Linus from parseArgs\n",
      stderr: "",
    });
  });

  it("keeps compatibility subpaths documented and exported", async () => {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
      exports: Record<string, unknown>;
    };

    expect(packageJson.exports).toHaveProperty("./credentials");
    expect(packageJson.exports).toHaveProperty("./config");
    expect(packageJson.exports).toHaveProperty("./client");
    expect(packageJson.exports).toHaveProperty("./ui");
    expect(packageJson.exports).toHaveProperty("./stdio");
    expect(packageJson.exports).toHaveProperty("./prompt");
  });

  it("documents representative repository CLI adoption notes", async () => {
    const readme = await fs.readFile(readmePath, "utf8");

    expect(readme).toContain("packages/cli");
    expect(readme).toContain("hostfn/cli");
    expect(readme).toContain("apifn/cli");
    expect(readme).toContain("plugfn/cli");
    expect(readme).toContain("extfn/cli");

    expect(readme).toContain("`extfn/cli` SHOULD use:");
    expect(readme).toContain("`extfn/cli` MUST stay extfn-owned for:");
  });

  it("references repository files that actually exist in the migration guidance", async () => {
    const referencedPaths = [
      "packages/cli/src/utils/load-library-config.ts",
      "packages/cli/src/utils/config.ts",
      "hostfn/cli/src/index.ts",
      "hostfn/cli/src/utils/logger.ts",
      "plugfn/cli/src/commands/runtime.ts",
      "plugfn/cli/src/commands/test.ts",
    ];

    await Promise.all(
      referencedPaths.map(async (relativePath) => {
        const stat = await fs.stat(path.join(repoRootPath, relativePath));
        expect(stat.isFile(), `Expected ${relativePath} to be a file`).toBe(true);
      })
    );
  });
});
