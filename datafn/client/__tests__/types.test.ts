import { describe, test, expectTypeOf } from "vitest";
import { createDatafnClient, type DatafnClient, type ResourceNames } from "../src/client.js";
import { defineSchema, type DatafnSchema, type DatafnSignal, type DfqlQueryFragment } from "@datafn/core";
import type { DatafnResourceRecord } from "../src/tables/table.js";

// Dummy schema for testing
const schema = {
  resources: [
    { name: "tasks", version: 1, fields: [] },
    { name: "users", version: 1, fields: [] },
  ],
} as const satisfies DatafnSchema;

type MySchema = typeof schema;

describe("DatafnClient Types", () => {
  test("client.<tableName> is typed", () => {
    const client = createDatafnClient({
      schema,
      sync: {
        remote: "http://example.com/api",
      },
      clientId: "test-client",
    });

    // Positive cases
    expectTypeOf(client.tasks).not.toBeAny();
    expectTypeOf(client.tasks.query).toBeFunction();
    expectTypeOf(client.users).not.toBeAny();

    // Negative cases (commented out as they are compile-time checks,
    // but expectation is that these would fail compilation if uncommented)
    // @ts-expect-error - unknown table
    expect(() => client.unknownTable).toThrow();
  });

  test("client.table(name) is typed", () => {
    const client = createDatafnClient({
      schema,
      sync: {
        remote: "http://example.com/api",
      },
      clientId: "test-client",
    });

    // Positive
    client.table("tasks");

    // Negative
    // @ts-expect-error - unknown table string
    expect(() => client.table("unknown")).toThrow();
  });

  test("DatafnTable accepts DfqlQueryFragment", () => {
    const client = createDatafnClient({
      schema,
      sync: {
        remote: "http://example.com/api",
      },
      clientId: "test-client",
    });

    const q: DfqlQueryFragment = { select: ["id"] };
    const queryFn: (query: DfqlQueryFragment) => unknown = client.tasks.query;

    expectTypeOf(q).toMatchTypeOf<DfqlQueryFragment>();
    expectTypeOf(queryFn).toBeFunction();

    // @ts-expect-error - invalid fragment key
    const invalidQuery: DfqlQueryFragment = { unknownKey: 123 };
    expectTypeOf(invalidQuery).toMatchTypeOf<DfqlQueryFragment>();
  });

  test("table signal infers row arrays from schema fields", () => {
    const stringField = <const Name extends string, const Required extends boolean>(name: Name, required: Required) =>
      ({ name, type: "string", required, nullable: !required }) as const;
    const booleanField = <const Name extends string, const Required extends boolean>(name: Name, required: Required) =>
      ({ name, type: "boolean", required, nullable: !required }) as const;
    const typedSchema = defineSchema({
      resources: [
        {
          name: "tasks",
          version: 1,
          capabilities: ["timestamps", "audit"],
          fields: [
            stringField("id", true),
            stringField("title", true),
            booleanField("done", false),
          ],
        },
      ],
    });
    const client = createDatafnClient({
      schema: typedSchema,
      sync: {
        remote: "http://example.com/api",
      },
      clientId: "test-client",
    });

    const signal = client.tasks.signal({
      select: ["id", "title"],
      filters: { done: false },
    });

    expectTypeOf(signal).not.toBeAny();
    expectTypeOf(signal).toMatchTypeOf<
      DatafnSignal<Array<{ id: string; title: string }>>
    >();
    expectTypeOf<ResourceNames<typeof typedSchema>>().toEqualTypeOf<"tasks">();
    type PublicSchemaShape = Pick<typeof typedSchema, "resources"> & DatafnSchema;
    expectTypeOf<ResourceNames<PublicSchemaShape>>().toEqualTypeOf<string>();
    expectTypeOf<DatafnClient<PublicSchemaShape>["tasks"]>().not.toBeAny();
    type TaskRecord = DatafnResourceRecord<typeof typedSchema, "tasks">;
    expectTypeOf<TaskRecord["id"]>().toEqualTypeOf<string>();
    expectTypeOf<TaskRecord["title"]>().toEqualTypeOf<string>();
    expectTypeOf<TaskRecord["done"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<TaskRecord["createdAt"]>().toEqualTypeOf<string | Date>();
    expectTypeOf<TaskRecord["updatedAt"]>().toEqualTypeOf<string | Date>();
    expectTypeOf<TaskRecord["updatedBy"]>().toEqualTypeOf<string | null | undefined>();
    const queryPromise = client.tasks.query({
      select: ["id", "title", "updatedAt"],
    });
    type QueryRow = Awaited<typeof queryPromise>["data"][number];
    expectTypeOf<QueryRow["id"]>().toEqualTypeOf<string>();
    expectTypeOf<QueryRow["title"]>().toEqualTypeOf<string>();
    expectTypeOf<QueryRow["updatedAt"]>().toEqualTypeOf<string | Date>();
    expectTypeOf(client.tasks.select("task:1")).toMatchTypeOf<
      Promise<TaskRecord | undefined>
    >();
    const selectedTaskPromise = client.tasks.select("task:1", {
      select: ["id", "title"],
    });
    type SelectedTask = NonNullable<Awaited<typeof selectedTaskPromise>>;
    expectTypeOf<SelectedTask["id"]>().toEqualTypeOf<string>();
    expectTypeOf<SelectedTask["title"]>().toEqualTypeOf<string>();
    type SignalValue = ReturnType<typeof signal.get>;
    type SignalRow = SignalValue[number];
    expectTypeOf<SignalRow["id"]>().toEqualTypeOf<string>();
    expectTypeOf<SignalRow["title"]>().toEqualTypeOf<string>();
  });
});
