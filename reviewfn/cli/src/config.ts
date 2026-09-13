import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { DEFAULT_CONFIG, DEFAULT_POLICY, validateConfig, validatePolicy, type ReviewFnConfig, type ReviewPolicy } from "@superfunctions/reviewfn-core";

const execFileAsync = promisify(execFile);

export async function loadConfig(file: string): Promise<ReviewFnConfig> {
  return validateConfig(JSON.parse(await readFile(file, "utf8")));
}

export async function loadPolicy(file: string): Promise<ReviewPolicy> {
  return validatePolicy(JSON.parse(await readFile(file, "utf8")));
}

export async function loadTrustedConfigFromBase(root: string, base: string, relative = ".reviewfn/config.json"): Promise<ReviewFnConfig> {
  if (relative.startsWith("/") || relative.split(/[\\/]/).includes("..")) throw new Error("Trusted configuration path must be repository-relative.");
  const { stdout } = await execFileAsync("git", ["show", `${base}:${relative}`], { cwd: root, maxBuffer: 5_000_000 });
  return validateConfig(JSON.parse(stdout));
}

export async function loadTrustedPolicyFromBase(root: string, base: string, relative = ".reviewfn/policy.json"): Promise<ReviewPolicy> {
  if (relative.startsWith("/") || relative.split(/[\\/]/).includes("..")) throw new Error("Trusted policy path must be repository-relative.");
  const { stdout } = await execFileAsync("git", ["show", `${base}:${relative}`], { cwd: root, maxBuffer: 5_000_000 });
  return validatePolicy(JSON.parse(stdout));
}

export async function initializeConfiguration(root: string): Promise<string[]> {
  const directory = path.join(root, ".reviewfn");
  await mkdir(directory, { recursive: true });
  const files = [path.join(directory, "config.json"), path.join(directory, "policy.json")];
  for (const file of files) {
    try { await readFile(file); throw new Error(`Refusing to overwrite ${path.relative(root, file)}.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await writeFile(files[0], `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  await writeFile(files[1], `${JSON.stringify(DEFAULT_POLICY, null, 2)}\n`);
  return files;
}
