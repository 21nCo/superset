import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

const isFileFnServerContractRun =
  args.length === 2 &&
  args[0] === "--run" &&
  args[1] === "filefn/server/tests/client-contract.test.ts";

const command = isFileFnServerContractRun
  ? [
      "npm",
      [
        "exec",
        "--yes",
        "--package=vitest@3.2.4",
        "vitest",
        "--config",
        "filefn/server/vitest.config.ts",
        "--run",
        "filefn/server/tests/client-contract.test.ts",
      ],
    ]
  : ["npx", ["turbo", "run", "test", "--", ...args]];

const result = spawnSync(command[0], command[1], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
