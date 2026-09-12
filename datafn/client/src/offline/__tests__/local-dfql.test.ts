import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStorageAdapter } from "../../adapters/memoryStorage.js";
import { executeLocalQuery } from "../query.js";
import { handleOfflineMutation } from "../mutate.js";
import type { DatafnSchema } from "@datafn/core";

const schema: DatafnSchema = {
  resources: [
    {
      name: "tasks",
      version: 1,
      fields: [
        { name: "title", type: "string", required: false },
        { name: "projectId", type: "string", required: false },
        { name: "status", type: "string", required: false },
      ],
    },
    {
      name: "projects",
      version: 1,
      fields: [
        { name: "name", type: "string", required: false },
        { name: "ownerId", type: "string", required: false },
      ],
    },
    {
      name: "users",
      version: 1,
      fields: [{ name: "name", type: "string", required: false }],
    },
    {
      name: "tags",
      version: 1,
      fields: [{ name: "name", type: "string", required: false }],
    },
    {
      name: "goals",
      version: 1,
      fields: [
        { name: "label", type: "string", required: false },
        { name: "parentId", type: "string", required: false },
        { name: "parentPath", type: "string", required: false },
        { name: "isArchived", type: "boolean", required: false },
      ],
    },
  ],
  relations: [
    {
      from: "tasks",
      relation: "project",
      to: "projects",
      type: "many-one",
      foreignKey: "projectId",
    },
    {
      from: "projects",
      relation: "owner",
      to: "users",
      type: "many-one",
      fkField: "ownerId",
    },
    {
      from: "tasks",
      relation: "tags",
      to: "tags",
      type: "many-many",
      metadata: [{ name: "order", type: "number" }],
    },
    {
      from: "goals",
      relation: "children",
      to: "goals",
      type: "htree",
      inverse: "parent",
      foreignKey: "parentId",
      pathField: "parentPath",
      inheritsInactive: true,
    },
  ],
};

describe("Local DFQL Expansion", () => {
  let storage: any;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter(["tasks", "projects", "users", "tags", "goals"]);

    // Seed data
    await storage.upsertRecord("tasks", {
      id: "t1",
      title: "Task 1",
      projectId: "p1",
      status: "active",
    });
    await storage.upsertRecord("projects", {
      id: "p1",
      name: "Project 1",
      ownerId: "u1",
    });
    await storage.upsertRecord("users", { id: "u1", name: "User 1" });
    await storage.upsertRecord("tags", { id: "tag1", name: "Tag 1" });
    await storage.upsertRecord("goals", { id: "g1", label: "Root", parentPath: "" });
    await storage.upsertRecord("goals", {
      id: "g2",
      label: "Child",
      parentId: "g1",
      parentPath: "g1",
    });
    await storage.upsertRecord("goals", {
      id: "g3",
      label: "Grand",
      parentId: "g2",
      parentPath: "g1-g2",
    });

    // Join row
    await storage.upsertJoinRow("join_tasks_tags_tags", {
      from: "t1",
      to: "tag1",
      order: 1,
    });
  });

  it("TV-OFFLINE-QUERY-REL-001: Local query expands relations", async () => {
    const result = await executeLocalQuery(storage, schema, {
      resource: "tasks",
      filters: { id: "t1" },
      select: ["title", "project.*"],
    });

    expect(result.data![0].project).toEqual({
      id: "p1",
      name: "Project 1",
      ownerId: "u1",
    });
  });

  it("TV-OFFLINE-QUERY-NESTED-001: Local query expands nested relations", async () => {
    const result = await executeLocalQuery(storage, schema, {
      resource: "tasks",
      filters: { id: "t1" },
      select: ["title", "project.owner.*"],
    });

    expect(result.data![0].project.owner).toEqual({ id: "u1", name: "User 1" });
  });

  it("filters records through many-one relation dot paths", async () => {
    await storage.upsertRecord("tasks", {
      id: "t2",
      title: "Task 2",
      projectId: "p2",
      status: "active",
    });
    await storage.upsertRecord("projects", { id: "p2", name: "Project 2" });

    const result = await executeLocalQuery(storage, schema, {
      resource: "tasks",
      filters: { "project.name": "Project 1" },
      select: ["id", "title"],
    });

    expect(result.data!.map((item: any) => item.id)).toEqual(["t1"]);
  });

  it("TV-OFFLINE-QUERY-MANYMANY-001: Local query expands many-many", async () => {
    const result = await executeLocalQuery(storage, schema, {
      resource: "tasks",
      filters: { id: "t1" },
      select: ["title", "tags.*"],
    });

    expect(result.data![0].tags).toHaveLength(1);
    expect(result.data![0].tags[0].name).toBe("Tag 1");
  });

  it("filters records through many-many relation quantifiers", async () => {
    await storage.upsertRecord("tasks", {
      id: "t2",
      title: "Task 2",
      status: "active",
    });

    const result = await executeLocalQuery(storage, schema, {
      resource: "tasks",
      filters: { tags: { $any: { id: "tag1" } } },
      select: ["id", "title"],
    });

    expect(result.data!.map((item: any) => item.id)).toEqual(["t1"]);
  });

  it("filters records through many-many relation dot paths", async () => {
    await storage.upsertRecord("tasks", {
      id: "t2",
      title: "Task 2",
      status: "active",
    });

    const result = await executeLocalQuery(storage, schema, {
      resource: "tasks",
      filters: { "tags.id": "tag1" },
      select: ["id", "title"],
    });

    expect(result.data!.map((item: any) => item.id)).toEqual(["t1"]);
  });

  it("expands polymorphic many-many relations by concrete target resource", async () => {
    const polymorphicSchema: DatafnSchema = {
      resources: [
        {
          name: "node",
          version: 1,
          fields: [{ name: "label", type: "string", required: false }],
        },
        {
          name: "objective",
          version: 1,
          fields: [{ name: "label", type: "string", required: false }],
        },
        {
          name: "collection",
          version: 1,
          fields: [{ name: "label", type: "string", required: false }],
        },
      ],
      relations: [
        {
          from: ["node", "objective"],
          to: "collection",
          type: "many-many",
          relation: "collections",
          inverse: "items",
          metadata: [{ name: "sortOrder", type: "number" }],
        },
      ],
    };
    const polymorphicStorage = new MemoryStorageAdapter([
      "node",
      "objective",
      "collection",
    ]);
    await polymorphicStorage.upsertRecord("node", { id: "node:1", label: "Node 1" });
    await polymorphicStorage.upsertRecord("objective", {
      id: "objective:1",
      label: "Objective 1",
    });
    await polymorphicStorage.upsertRecord("collection", {
      id: "collection:1",
      label: "Collection 1",
    });
    await polymorphicStorage.upsertJoinRow("join_node_collections_collection", {
      from: "node:1",
      to: "collection:1",
      sortOrder: 1,
    });
    await polymorphicStorage.upsertJoinRow("join_objective_collections_collection", {
      from: "objective:1",
      to: "collection:1",
      sortOrder: 2,
    });

    const collectionResult = await executeLocalQuery(
      polymorphicStorage,
      polymorphicSchema,
      {
        resource: "collection",
        filters: { id: "collection:1" },
        select: ["id", "items.*#"],
      },
    );

    expect(collectionResult.data![0].items).toEqual([
      {
        id: "node:1",
        label: "Node 1",
        from: "node:1",
        to: "collection:1",
        sortOrder: 1,
      },
      {
        id: "objective:1",
        label: "Objective 1",
        from: "objective:1",
        to: "collection:1",
        sortOrder: 2,
      },
    ]);

    const nodeResult = await executeLocalQuery(
      polymorphicStorage,
      polymorphicSchema,
      {
        resource: "node",
        filters: { collections: { $any: { id: "collection:1" } } },
        select: ["id", "label"],
      },
    );
    expect(nodeResult.data).toEqual([{ id: "node:1", label: "Node 1" }]);

    const objectiveResult = await executeLocalQuery(
      polymorphicStorage,
      polymorphicSchema,
      {
        resource: "objective",
        filters: { "collections.id": "collection:1" },
        select: ["id", "label"],
      },
    );
    expect(objectiveResult.data).toEqual([
      { id: "objective:1", label: "Objective 1" },
    ]);
  });

  it("expands explicit relation ids when wildcard fields are selected", async () => {
    const result = await executeLocalQuery(storage, schema, {
      resource: "tasks",
      filters: { id: "t1" },
      select: ["*", "tags"],
    });

    expect(result.data![0].title).toBe("Task 1");
    expect(result.data![0].tags).toEqual(["tag1"]);
  });

  it("TV-OFFLINE-QUERY-HTREE-001: Local query expands htree parents and descendants", async () => {
    const childResult = await executeLocalQuery(storage, schema, {
      resource: "goals",
      filters: { id: "g3" },
      select: ["id", "parent.*"],
    });

    expect(childResult.data![0].parent.map((item: any) => item.id)).toEqual([
      "g1",
      "g2",
    ]);

    const rootResult = await executeLocalQuery(storage, schema, {
      resource: "goals",
      filters: { id: "g1" },
      select: ["id", "children.**"],
    });

    expect(rootResult.data![0].children.map((item: any) => item.id)).toEqual([
      "g2",
      "g3",
    ]);
  });

  it("TV-OFFLINE-MUTATE-HTREE-001: Local relate updates htree parent and path fields", async () => {
    await storage.upsertRecord("goals", { id: "g4", label: "New child" });
    await handleOfflineMutation(
      storage,
      schema,
      {
        clientId: "client-1",
        mutationId: "mut-htree-1",
        resource: "goals",
        version: 1,
        operation: "relate",
        id: "g1",
        relations: {
          children: [{ $ref: "g4" }],
        },
      },
      Date.now(),
    );

    expect(await storage.getRecord("goals", "g4")).toMatchObject({
      parentId: "g1",
      parentPath: "g1",
    });

    const rootResult = await executeLocalQuery(storage, schema, {
      resource: "goals",
      filters: { id: "g1" },
      select: ["id", "children.**"],
    });

    expect(rootResult.data![0].children.map((item: any) => item.id)).toContain("g4");
  });

  it("TV-OFFLINE-MUTATE-HTREE-002: Local archive propagation updates and filters descendants", async () => {
    await handleOfflineMutation(
      storage,
      schema,
      {
        clientId: "client-1",
        mutationId: "mut-htree-2",
        resource: "goals",
        version: 1,
        operation: "archive",
        id: "g1",
      },
      Date.now(),
    );

    expect(await storage.getRecord("goals", "g2")).toMatchObject({
      isAncestorInactive: true,
    });
    expect(await storage.getRecord("goals", "g3")).toMatchObject({
      isAncestorInactive: true,
    });

    const filteredResult = await executeLocalQuery(storage, schema, {
      resource: "goals",
      filters: { id: "g1" },
      select: ["id", "children.**"],
    });
    expect(filteredResult.data![0].children).toEqual([]);

    const unfilteredResult = await executeLocalQuery(storage, schema, {
      resource: "goals",
      filters: { id: "g1" },
      select: ["id", "children.**"],
      metadata: { includeAncestorInactive: true },
    });
    expect(unfilteredResult.data![0].children.map((item: any) => item.id)).toEqual([
      "g2",
      "g3",
    ]);

    await handleOfflineMutation(
      storage,
      schema,
      {
        clientId: "client-1",
        mutationId: "mut-htree-3",
        resource: "goals",
        version: 1,
        operation: "unarchive",
        id: "g1",
      },
      Date.now(),
    );

    expect(await storage.getRecord("goals", "g2")).toMatchObject({
      isAncestorInactive: false,
    });
    expect(await storage.getRecord("goals", "g3")).toMatchObject({
      isAncestorInactive: false,
    });
  });

  it("TV-OFFLINE-SORT-001: Local query sorts with '-field' prefix (descending)", async () => {
    await storage.upsertRecord("tasks", {
      id: "t2",
      title: "A Earlier Task",
      projectId: "p1",
      status: "active",
    });

    const result = await executeLocalQuery(storage, schema, {
      resource: "tasks",
      sort: ["-title"],
    });

    const titles = result.data!.map((r: any) => r.title);
    expect(titles[0]).toBe("Task 1");
    expect(titles[1]).toBe("A Earlier Task");
  });

  it("TV-OFFLINE-SORT-002: Local query '-field' sort equivalent to 'field:desc'", async () => {
    await storage.upsertRecord("tasks", {
      id: "t2",
      title: "A Earlier Task",
      projectId: "p1",
      status: "active",
    });

    const resultDash = await executeLocalQuery(storage, schema, {
      resource: "tasks",
      sort: ["-title"],
    });

    const resultColon = await executeLocalQuery(storage, schema, {
      resource: "tasks",
      sort: ["title:desc"],
    });

    const titlesDash = resultDash.data!.map((r: any) => r.title);
    const titlesColon = resultColon.data!.map((r: any) => r.title);
    expect(titlesDash).toEqual(titlesColon);
  });

  it("TV-OFFLINE-SORT-003: Local query mixed '-field' and 'field:asc' formats", async () => {
    await storage.upsertRecord("tasks", {
      id: "t2",
      title: "A Earlier Task",
      status: "done",
    });

    const result = await executeLocalQuery(storage, schema, {
      resource: "tasks",
      sort: ["-status", "title:asc"],
    });

    const statuses = result.data!.map((r: any) => r.status);
    // "done" > "active" alphabetically, so desc means "done" first
    expect(statuses[0]).toBe("done");
    expect(statuses[1]).toBe("active");
  });

  it("TV-OFFLINE-SORT-004: Local query 'field:asc' ascending still works", async () => {
    await storage.upsertRecord("tasks", {
      id: "t2",
      title: "A Earlier Task",
      projectId: "p1",
      status: "active",
    });

    const result = await executeLocalQuery(storage, schema, {
      resource: "tasks",
      sort: ["title:asc"],
    });

    const titles = result.data!.map((r: any) => r.title);
    expect(titles[0]).toBe("A Earlier Task");
    expect(titles[1]).toBe("Task 1");
  });

  it("TV-OFFLINE-QUERY-GROUPBY-001: Local query aggregations", async () => {
    await storage.upsertRecord("tasks", {
      id: "t2",
      title: "Task 2",
      status: "active",
    });
    await storage.upsertRecord("tasks", {
      id: "t3",
      title: "Task 3",
      status: "done",
    });

    const result = await executeLocalQuery(storage, schema, {
      resource: "tasks",
      groupBy: ["status"],
      aggregations: { total: { op: "count", field: "*" } },
    });

    // active: 2, done: 1
    const active = result.groups!.find((g: any) => g.status === "active");
    expect(active.total).toBe(2);
  });
});
