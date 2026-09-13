import { buildManifest, type DocsContentProvider } from "@docsfn/core";
import { AdminError, adminScopeRootId, type AdminOperationContext } from "@superfunctions/admin";

export interface DocsFnOperatorScope {
  installationId: string;
  workspaceId: string;
  projectId: string;
  environmentId: string | null;
}

/** Closed, canonical subset of DocsConfig supported by the operator API. */
export interface DocsFnAdminConfig {
  schemaVersion: 1;
  site: {
    title: string;
    description?: string;
    basePath?: `/${string}`;
    canonicalUrl?: string;
    defaultLocale?: string;
    showFooter?: boolean;
  };
  compat?: { preset: "none" | "fumadocs-v15"; allowRawHtml?: false };
  content: {
    root: string;
    docsDir?: string | string[];
    pagesDir?: string;
    blogDir?: string;
    apiDir?: string;
    assetsDir?: string;
    metaFileName?: string;
  };
}
export interface DocsFnPageInput { cursor?: string; limit?: number }

export interface DocsFnSiteRecord {
  id: string;
  scope: DocsFnOperatorScope;
  name: string;
  config: DocsFnAdminConfig;
  createdAt: string;
  updatedAt: string;
}

export interface DocsFnSiteView {
  id: string;
  scope: DocsFnOperatorScope;
  name: string;
  title: string;
  basePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocsFnBuildRecord {
  id: string;
  scope: DocsFnOperatorScope;
  siteId: string;
  status: "succeeded" | "failed";
  pageCount: number;
  postCount: number;
  apiCount: number;
  error?: string;
  createdAt: string;
}

export interface DocsFnBuildView extends Omit<DocsFnBuildRecord, "error"> {
  hasError: boolean;
}

/** Durable persistence boundary owned by DocsFn. */
export interface DocsFnOperatorStore {
  listSites(scope: DocsFnOperatorScope): Promise<DocsFnSiteRecord[]>;
  getSite(scope: DocsFnOperatorScope, id: string): Promise<DocsFnSiteRecord | null>;
  putSite(value: DocsFnSiteRecord): Promise<void>;
  deleteSite(scope: DocsFnOperatorScope, id: string): Promise<boolean>;
  listBuilds(scope: DocsFnOperatorScope, siteId?: string): Promise<DocsFnBuildRecord[]>;
  getBuild(scope: DocsFnOperatorScope, id: string): Promise<DocsFnBuildRecord | null>;
  putBuild(value: DocsFnBuildRecord): Promise<void>;
}

/** Explicit in-memory implementation for tests and local development. */
export class MemoryDocsFnOperatorStore implements DocsFnOperatorStore {
  private readonly sites = new Map<string, DocsFnSiteRecord>();
  private readonly builds = new Map<string, DocsFnBuildRecord>();

  private key(scope: DocsFnOperatorScope, id: string): string {
    return `${scope.installationId}\0${scope.workspaceId}\0${scope.projectId}\0${scope.environmentId ?? ""}\0${id}`;
  }

  async listSites(scope: DocsFnOperatorScope): Promise<DocsFnSiteRecord[]> {
    const prefix = this.key(scope, "");
    return [...this.sites.values()]
      .filter((value) => this.key(value.scope, "") === prefix)
      .map((value) => structuredClone(value));
  }

  async getSite(scope: DocsFnOperatorScope, id: string): Promise<DocsFnSiteRecord | null> {
    const value = this.sites.get(this.key(scope, id));
    return value ? structuredClone(value) : null;
  }

  async putSite(value: DocsFnSiteRecord): Promise<void> {
    this.sites.set(this.key(value.scope, value.id), structuredClone(value));
  }

  async deleteSite(scope: DocsFnOperatorScope, id: string): Promise<boolean> {
    return this.sites.delete(this.key(scope, id));
  }

  async listBuilds(scope: DocsFnOperatorScope, siteId?: string): Promise<DocsFnBuildRecord[]> {
    const prefix = this.key(scope, "");
    return [...this.builds.values()]
      .filter((value) => this.key(value.scope, "") === prefix && (!siteId || value.siteId === siteId))
      .map((value) => structuredClone(value));
  }

  async getBuild(scope: DocsFnOperatorScope, id: string): Promise<DocsFnBuildRecord | null> {
    const value = this.builds.get(this.key(scope, id));
    return value ? structuredClone(value) : null;
  }

  async putBuild(value: DocsFnBuildRecord): Promise<void> {
    this.builds.set(this.key(value.scope, value.id), structuredClone(value));
  }
}

export interface DocsFnOperatorServiceOptions {
  store: DocsFnOperatorStore;
  /** Resolve the real site content provider; no static content is synthesized. */
  provider(
    site: DocsFnSiteRecord,
    context: AdminOperationContext,
  ): DocsContentProvider | Promise<DocsContentProvider>;
  now?: () => Date;
  createId?: () => string;
}

function requireScope(context: AdminOperationContext): DocsFnOperatorScope {
  const { workspaceId, projectId, environmentId } = context.scope;
  const installationId = adminScopeRootId(context.scope);
  if (!installationId || !workspaceId || !projectId) {
    throw new AdminError(
      "invalid_argument",
      "DocsFn administration requires installation, workspace, and project scope identifiers.",
    );
  }
  return { installationId, workspaceId, projectId, environmentId: environmentId ?? null };
}

function siteView(value: DocsFnSiteRecord): DocsFnSiteView {
  return {
    id: value.id,
    scope: value.scope,
    name: value.name,
    title: value.config.site.title,
    basePath: value.config.site.basePath ?? "/docs",
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function buildView(value: DocsFnBuildRecord): DocsFnBuildView {
  const { error, ...record } = value;
  return { ...record, hasError: error !== undefined };
}

function page<T extends { id: string }>(items: T[], input: DocsFnPageInput) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const offset = input.cursor === undefined ? 0 : Number(input.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AdminError("invalid_argument", "DocsFn cursor is invalid.");
  }
  const ordered = [...items].sort((left, right) => left.id.localeCompare(right.id));
  const values = ordered.slice(offset, offset + limit);
  const next = offset + values.length;
  return { items: values, nextCursor: next < ordered.length ? String(next) : null };
}

export function createDocsFnOperatorService(options: DocsFnOperatorServiceOptions) {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const createId = options.createId ?? (() => crypto.randomUUID());

  return {
    async listSites(input: DocsFnPageInput, context: AdminOperationContext) {
      const values = await options.store.listSites(requireScope(context));
      return page(values.map(siteView), input);
    },

    async getSite(input: { id: string }, context: AdminOperationContext) {
      const value = await options.store.getSite(requireScope(context), input.id);
      if (!value) throw new AdminError("not_found", "DocsFn site was not found.");
      return { item: siteView(value) };
    },

    async upsertSite(
      input: { id: string; name: string; config: DocsFnAdminConfig },
      context: AdminOperationContext,
    ) {
      const scope = requireScope(context);
      if (!input.id.trim() || !input.name.trim() || !input.config?.site?.title) {
        throw new AdminError("invalid_argument", "Site id, name, and config.site.title are required.");
      }
      const previous = await options.store.getSite(scope, input.id);
      const updatedAt = now();
      const value: DocsFnSiteRecord = {
        id: input.id,
        scope,
        name: input.name,
        config: structuredClone(input.config),
        createdAt: previous?.createdAt ?? updatedAt,
        updatedAt,
      };
      await options.store.putSite(value);
      return { accepted: true as const, item: siteView(value) };
    },

    async deleteSite(input: { id: string }, context: AdminOperationContext) {
      if (!await options.store.deleteSite(requireScope(context), input.id)) {
        throw new AdminError("not_found", "DocsFn site was not found.");
      }
      return { accepted: true as const };
    },

    async listBuilds(
      input: DocsFnPageInput & { siteId?: string },
      context: AdminOperationContext,
    ) {
      const values = await options.store.listBuilds(requireScope(context), input.siteId);
      return page(values.map(buildView), input);
    },

    async getBuild(input: { id: string }, context: AdminOperationContext) {
      const value = await options.store.getBuild(requireScope(context), input.id);
      if (!value) throw new AdminError("not_found", "DocsFn build was not found.");
      return { item: buildView(value) };
    },

    async runBuild(
      input: { siteId: string; preview?: boolean },
      context: AdminOperationContext,
    ) {
      const scope = requireScope(context);
      const site = await options.store.getSite(scope, input.siteId);
      if (!site) throw new AdminError("not_found", "DocsFn site was not found.");
      const id = createId();
      try {
        const manifest = await buildManifest(
          await options.provider(site, context),
          site.config,
          { preview: input.preview },
        );
        const value: DocsFnBuildRecord = {
          id,
          scope,
          siteId: site.id,
          status: "succeeded",
          pageCount: Object.keys(manifest.pages).length,
          postCount: Object.keys(manifest.posts).length,
          apiCount: Object.keys(manifest.apis).length,
          createdAt: now(),
        };
        await options.store.putBuild(value);
        return { accepted: true as const, item: buildView(value) };
      } catch (error) {
        const value: DocsFnBuildRecord = {
          id,
          scope,
          siteId: site.id,
          status: "failed",
          pageCount: 0,
          postCount: 0,
          apiCount: 0,
          error: error instanceof Error ? error.message : "Build failed",
          createdAt: now(),
        };
        await options.store.putBuild(value);
        throw new AdminError("precondition_failed", "DocsFn build failed.", {
          details: { buildId: id },
        });
      }
    },
  };
}

export type DocsFnOperatorService = ReturnType<typeof createDocsFnOperatorService>;
