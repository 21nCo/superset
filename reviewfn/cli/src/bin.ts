#!/usr/bin/env node
import { loadConfig, publishGitHub, runReview, writeReport } from "./index.js";

const [command = "review", ...args] = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const cwd = process.cwd();
try {
  const config = await loadConfig(cwd, option("--config"));
  if (command === "doctor") { console.log(JSON.stringify({ ok: true, node: process.version, config }, null, 2)); }
  else if (command === "review") { const report = await runReview(cwd, config); const paths = await writeReport(cwd, config, report); console.log(JSON.stringify({ execution: report.execution, coverage: report.coverage, verdict: report.verdict, ...paths }, null, 2)); if (report.execution !== "completed") process.exitCode = 2; }
  else if (command === "publish") { console.log(JSON.stringify(await publishGitHub(cwd, config), null, 2)); }
  else throw new Error(`unknown command: ${command}`);
} catch (error) { console.error(`reviewfn: ${(error as Error).message}`); process.exitCode = 2; }
