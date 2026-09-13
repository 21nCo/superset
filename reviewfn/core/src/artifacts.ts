import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "./canonical.js";
import { ReviewFnError } from "./errors.js";
import type { ArtifactStore } from "./types.js";

interface ArtifactMetadata { id: string; digest: string; kind: string; createdAt: string; expiresAt: string }

function validateKind(kind: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(kind)) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", `Unsafe artifact kind ${kind}.`);
}

export class FileArtifactStore implements ArtifactStore {
  public constructor(private readonly root: string) {}

  public async put(kind: string, content: string | Uint8Array, retentionDays: number): Promise<{ digest: string; id: string }> {
    validateKind(kind);
    if (!Number.isInteger(retentionDays) || retentionDays <= 0) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", "retentionDays must be a positive integer.");
    await this.ensureSafeRoot();
    const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    const digest = sha256(bytes);
    const id = `${kind}-${digest}`;
    const dataPath = path.join(this.root, `${id}.artifact`);
    const metadataPath = path.join(this.root, `${id}.json`);
    const createdAt = new Date();
    const metadata: ArtifactMetadata = { id, digest, kind, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + retentionDays * 86_400_000).toISOString() };
    await writeExclusiveOrVerify(dataPath, bytes, digest);
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });
    return { digest, id };
  }

  public async get(id: string): Promise<Uint8Array | undefined> {
    if (!/^[a-z][a-z0-9-]{0,63}-[a-f0-9]{64}$/.test(id)) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", `Unsafe artifact id ${id}.`);
    return readFile(path.join(this.root, `${id}.artifact`)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  }

  public async deleteExpired(now = new Date()): Promise<{ deleted: string[]; errors: string[] }> {
    await this.ensureSafeRoot();
    const deleted: string[] = [];
    const errors: string[] = [];
    for (const entry of await readdir(this.root)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const metadata = JSON.parse(await readFile(path.join(this.root, entry), "utf8")) as ArtifactMetadata;
        if (Date.parse(metadata.expiresAt) > now.getTime()) continue;
        const artifactPath = path.join(this.root, `${metadata.id}.artifact`);
        if ((await lstat(artifactPath).catch(() => undefined))?.isSymbolicLink()) throw new Error("refusing symlinked artifact");
        await rm(artifactPath, { force: true });
        await rm(path.join(this.root, entry));
        deleted.push(metadata.id);
      } catch (error) {
        errors.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { deleted, errors };
  }

  private async ensureSafeRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", "Artifact root must be a real directory.");
  }
}

async function writeExclusiveOrVerify(file: string, bytes: Uint8Array, digest: string): Promise<void> {
  try {
    const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await access(file, constants.R_OK);
    const existing = await readFile(file);
    if (sha256(existing) !== digest) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", "Existing content-addressed artifact has unexpected bytes.");
  }
}
