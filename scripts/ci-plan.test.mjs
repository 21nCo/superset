import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// A tiny, disposable Git fixture exercises the actual planner and its diff discovery.
test("CI changes cannot silently disable Python coverage", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-plan-contract-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Planner Test", GIT_AUTHOR_EMAIL: "planner@example.invalid",
    GIT_COMMITTER_NAME: "Planner Test", GIT_COMMITTER_EMAIL: "planner@example.invalid",
  };
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (file, contents) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  };
  try {
    for (const file of ["ci-plan.mjs", "ci-utils.mjs"]) put(`scripts/${file}`, readFileSync(new URL(file, import.meta.url), "utf8"));
    put("example/python/pyproject.toml", '[project]\nname = "example-python"\n');
    put("docsfn/docs/package.json", '{"name":"@docsfn/site","scripts":{"build":"echo build"}}');
    put("docsfn/docs/content.md", "# Docs\n");
    put(".github/workflows/ci.yml", "jobs: {}\n");
    put("README.md", "# Fixture\n");
    git("init", "--quiet", "--initial-branch=dev");
    git("add", "."); git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    for (const [file, python, js] of [
      [".github/workflows/ci.yml", true, true],
      ["scripts/ci-plan.mjs", true, true],
      ["README.md", false, false],
      ["docsfn/docs/content.md", false, true],
    ]) {
      git("reset", "--hard", base);
      const prior = readFileSync(path.join(root, file), "utf8");
      put(file, prior + (file.endsWith(".mjs") ? "\n// changed\n" : "\n# changed\n"));
      git("add", file); git("commit", "--quiet", "-m", "change");
      put(".git/event.json", JSON.stringify({ before: base }));
      const outputFile = path.join(root, ".git/outputs");
      writeFileSync(outputFile, "");
      execFileSync(process.execPath, ["scripts/ci-plan.mjs"], { cwd: root, env: { ...env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: path.join(root, ".git/event.json"), GITHUB_OUTPUT: outputFile }, stdio: ["ignore", "pipe", "pipe"] });
      const outputs = readFileSync(outputFile, "utf8");
      assert.match(outputs, new RegExp(`^run_python<<__CI_EOF__\n${python}\n__CI_EOF__$`, "m"), file);
      assert.match(outputs, new RegExp(`^run_js<<__CI_EOF__\n${js}\n__CI_EOF__$`, "m"), file);
      assert.doesNotMatch(outputs, /run_docs(?:=|<<)/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
