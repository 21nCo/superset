import { describe, expect, it, vi } from "vitest";
import type {
  DocsContentProvider,
  DocsProviderListEntriesInput,
  DocsProviderLoadEntryInput,
  DocsSourceEntry,
  RawContentEntry,
} from "@docsfn/core";
import {
  createAdminClient,
  validateAdminCapabilityManifest,
  type AdminOperationContext,
} from "@superfunctions/admin";
import {
  createDocsFnAdminAdapter,
  createDocsFnAdminClient,
  createDocsFnOperatorService,
  docsFnAdminCapability,
  MemoryDocsFnOperatorStore,
  type DocsFnAdminConfig,
} from "../index.js";

const config: DocsFnAdminConfig = {
  schemaVersion: 1,
  site: { title: "Product Docs", basePath: "/docs" },
  compat: { preset: "none" },
  content: {
    root: "/virtual/docs",
    docsDir: "docs",
    pagesDir: "pages",
    blogDir: "blog",
    apiDir: "api",
    assetsDir: "public",
    metaFileName: "meta.json",
  },
};
const entry: DocsSourceEntry = {
  id: "docs:intro.mdx",
  collection: "docs",
  relativePath: "intro.mdx",
  absolutePath: "/virtual/docs/docs/intro.mdx",
  entryType: "content",
  frontmatter: { title: "Introduction" },
  body: "# Introduction\n\nHello from DocsFn.",
};
const provider: DocsContentProvider = {
  providerId: "admin-integration",
  async listEntries(input: DocsProviderListEntriesInput) {
    return input.collections.includes("docs") ? [entry] : [];
  },
  async loadEntry(input: DocsProviderLoadEntryInput) {
    return input.entry;
  },
  async list(): Promise<RawContentEntry[]> {
    return [{ id: "intro.mdx", kind: "page", body: entry.body!, frontmatter: entry.frontmatter }];
  },
};

function context(
  projectId: string,
  workspaceId = "workspace",
  environmentId?: string,
): AdminOperationContext {
  return {
    scope: { installationId: "installation", workspaceId, projectId, environmentId },
    actor: { id: "operator", permissions: ["*"] },
    requestId: crypto.randomUUID(),
    source: "console",
    idempotencyKey: crypto.randomUUID(),
  };
}

function legacyContext(projectId: string): AdminOperationContext {
  return { ...context(projectId), scope: { organizationId: "installation", workspaceId: "workspace", projectId } };
}

describe("@docsfn/admin", () => {
  it("publishes a valid optional operator surface", () => {
    expect(validateAdminCapabilityManifest(docsFnAdminCapability)).toEqual([]);
    expect(docsFnAdminCapability.availability).toBe("optional-product");
    expect(docsFnAdminCapability.operations).toHaveLength(7);
  });

  it("builds through DocsFn core, paginates, and isolates the full scope", async () => {
    let id = 0;
    const adapter = createDocsFnAdminAdapter(createDocsFnOperatorService({
      store: new MemoryDocsFnOperatorStore(),
      provider: async () => provider,
      createId: () => `build-${++id}`,
    }));

    await adapter.execute("docsfn.sites.upsert", { id: "main", name: "Main", config }, context("same-project"));
    await adapter.execute("docsfn.sites.upsert", { id: "api", name: "API", config }, context("same-project"));
    const built = await adapter.execute<any>("docsfn.builds.run", { siteId: "main" }, context("same-project"));
    expect(built.data.item).toMatchObject({ status: "succeeded", pageCount: 1, hasError: false });

    const first = await adapter.execute<any>("docsfn.sites.list", { limit: 1 }, context("same-project"));
    const second = await adapter.execute<any>(
      "docsfn.sites.list",
      { limit: 1, cursor: first.data.nextCursor },
      context("same-project"),
    );
    expect(first.data.nextCursor).toBe("1");
    expect(second.data.nextCursor).toBeNull();
    expect((await adapter.execute<any>("docsfn.sites.list", {}, legacyContext("same-project"))).data.items).toHaveLength(2);

    const otherWorkspace = await adapter.execute<any>(
      "docsfn.sites.list",
      {},
      context("same-project", "other-workspace"),
    );
    const otherEnvironment = await adapter.execute<any>(
      "docsfn.sites.list",
      {},
      context("same-project", "workspace", "production"),
    );
    expect(otherWorkspace.data.items).toEqual([]);
    expect(otherEnvironment.data.items).toEqual([]);
  });

  it("exposes named typed client methods and common capability methods", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { items: [], nextCursor: null },
    }), { status: 200 }));
    const client = createDocsFnAdminClient(createAdminClient({
      baseUrl: "https://example.test/admin",
      fetch: fetcher as typeof fetch,
    }));
    await client.sites.list();
    expect(String(fetcher.mock.calls[0]![0])).toContain("docsfn.sites.list");
    expect(client.builds.run).toEqual(expect.any(Function));
    expect(client.availability).toEqual(expect.any(Function));
  });
});
