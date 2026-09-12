import { describe, expect, it } from "vitest";
import { field } from "../src/field.js";
import { validateSchema } from "../src/schema.js";

describe("field", () => {
  it("builds plain field schemas with explicit required and nullable defaults", () => {
    expect(field.string("status")).toEqual({
      name: "status",
      type: "string",
      required: false,
      nullable: false,
    });
    expect(
      field.boolean("isStarred", {
        required: true,
        nullable: true,
        default: null,
        readonly: true,
      }),
    ).toEqual({
      name: "isStarred",
      type: "boolean",
      required: true,
      nullable: true,
      default: null,
      readonly: true,
    });
  });

  it("supports every public field kind", () => {
    const fields = [
      field.string("string"),
      field.number("number"),
      field.boolean("boolean"),
      field.object("object"),
      field.array("array"),
      field.date("date"),
      field.file("file"),
      field.json("json"),
    ];
    expect(fields).toEqual([
      { name: "string", type: "string", required: false, nullable: false },
      { name: "number", type: "number", required: false, nullable: false },
      { name: "boolean", type: "boolean", required: false, nullable: false },
      { name: "object", type: "object", required: false, nullable: false },
      { name: "array", type: "array", required: false, nullable: false },
      { name: "date", type: "date", required: false, nullable: false },
      { name: "file", type: "file", required: false, nullable: false },
      { name: "json", type: "json", required: false, nullable: false },
    ]);
    expect(
      validateSchema({
        resources: [{ name: "allFields", version: 1, fields }],
      }).ok,
    ).toBe(true);
  });

  it("preserves type-appropriate field metadata", () => {
    expect(
      field.string("status", {
        required: true,
        enum: ["NOT_STARTED", "IN_PROGRESS", "COMPLETED"],
        minLength: 1,
        maxLength: 20,
        pattern: "^[A-Z_]+$",
        unique: "project",
        encrypt: true,
        volatile: false,
      }),
    ).toEqual({
      name: "status",
      type: "string",
      required: true,
      nullable: false,
      enum: ["NOT_STARTED", "IN_PROGRESS", "COMPLETED"],
      minLength: 1,
      maxLength: 20,
      pattern: "^[A-Z_]+$",
      unique: "project",
      encrypt: true,
      volatile: false,
    });
    expect(field.date("dueAt", { min: 0, max: 1 })).toEqual({
      name: "dueAt",
      type: "date",
      required: false,
      nullable: false,
      min: 0,
      max: 1,
    });
  });

  it("omits undefined defaults", () => {
    const built = field.string("title", { default: undefined });
    expect(Object.prototype.hasOwnProperty.call(built, "default")).toBe(false);
  });
});
