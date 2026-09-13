import { digestJson, type ArtifactStore, type ChangeSnapshot, type ContextAdapter, type ContextManifest, type ContextRequest, type ExecutionAdapter, type HarnessAdapter, type HarnessCapabilities, type HarnessInput, type HarnessOutput, type PreflightResult, type PublishRequest, type PublishResult, type ReportPublisher, type ReviewPolicy, type SourceControlAdapter, type TestReceipt } from "@superfunctions/reviewfn-core";

const ok: PreflightResult = { ok: true, diagnostics: [] };

export class MemoryArtifactStore implements ArtifactStore {
  public readonly values = new Map<string, Uint8Array>();
  public async put(kind: string, content: string | Uint8Array): Promise<{ digest: string; id: string }> { const bytes = Buffer.from(content); const digest = digestJson([...bytes]); const id = `${kind}-${digest}`; this.values.set(id, bytes); return { digest, id }; }
  public async get(id: string): Promise<Uint8Array | undefined> { return this.values.get(id); }
  public async deleteExpired(): Promise<{ deleted: string[]; errors: string[] }> { return { deleted: [], errors: [] }; }
}

export class FakeContextAdapter implements ContextAdapter {
  public readonly id: string;
  public constructor(id: string, private readonly manifest: Omit<ContextManifest, "digest">, private readonly preflightResult: PreflightResult = ok) { this.id = id; }
  public async preflight(_request: ContextRequest): Promise<PreflightResult> { return this.preflightResult; }
  public async fetch(_request: ContextRequest): Promise<Omit<ContextManifest, "digest">> { return structuredClone(this.manifest); }
}

export class FakeSourceControlAdapter implements SourceControlAdapter {
  public readonly id = "fake-source";
  public current = "b".repeat(40);
  public async capture(): Promise<ChangeSnapshot> { return { repositoryId: "fixture", host: "local", targetBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), mergeBaseCommit: "a".repeat(40), diffDigest: "c".repeat(64), changedPaths: ["src/value.ts"], capturedAt: "2026-01-01T00:00:00.000Z" }; }
  public async currentHead(): Promise<string> { return this.current; }
  public async verifyAnchor(_root: string, anchor: { path: string }): Promise<boolean> { return anchor.path === "src/value.ts"; }
}

export class FakeHarnessAdapter implements HarnessAdapter {
  public readonly capabilities: HarnessCapabilities = { id: "fake", version: "1", providers: ["fake"], authModes: ["none"], structuredOutput: true, observableEvents: true, usageMetrics: true, cancellation: true, toolControls: true, sandboxModes: ["isolated"] };
  public constructor(private readonly output: HarnessOutput) {}
  public async preflight(): Promise<PreflightResult> { return ok; }
  public async run(_input: HarnessInput): Promise<HarnessOutput> { return structuredClone(this.output); }
}

export class FakeExecutionAdapter implements ExecutionAdapter {
  public readonly id = "fake-execution";
  public constructor(private readonly receipts: TestReceipt[] = []) {}
  public async preflight(): Promise<PreflightResult> { return ok; }
  public async run(_root: string, _headCommit: string, _commands: string[][], _policy: ReviewPolicy): Promise<TestReceipt[]> { return structuredClone(this.receipts); }
}

export class FakePublisher implements ReportPublisher {
  public readonly id = "fake-publisher";
  public readonly requests: PublishRequest[] = [];
  public async preflight(): Promise<PreflightResult> { return ok; }
  public async publish(request: PublishRequest): Promise<PublishResult> { this.requests.push(request); return { status: "published", reference: "fixture" }; }
}
