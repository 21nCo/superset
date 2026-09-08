import type { DatafnFieldSchema } from "./types.js";

type DatafnFieldType = DatafnFieldSchema["type"];
type NoFieldOptions = Record<never, never>;

type DatafnFieldMetadataOptions = Partial<
  Pick<DatafnFieldSchema, "readonly" | "unique" | "encrypt" | "volatile">
>;

type DatafnFieldCommonOptions<Value> = DatafnFieldMetadataOptions & {
  required?: boolean;
} & (
    | {
        nullable?: false;
        default?: Value;
      }
    | {
        nullable: true;
        default?: Value | null;
      }
  );

type DatafnEnumOptions<Value> = {
  enum?: readonly Value[];
};

/** A JSON-compatible value accepted by a DataFn JSON field. */
export type DatafnJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly DatafnJsonValue[]
  | { readonly [key: string]: DatafnJsonValue };

/** Named options for a string field. */
export type DatafnStringFieldOptions = DatafnFieldCommonOptions<string> &
  DatafnEnumOptions<string> & {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };

/** Named options for a number field. */
export type DatafnNumberFieldOptions = DatafnFieldCommonOptions<number> &
  DatafnEnumOptions<number> & {
    min?: number;
    max?: number;
  };

/** Named options for a boolean field. */
export type DatafnBooleanFieldOptions = DatafnFieldCommonOptions<boolean> &
  DatafnEnumOptions<boolean>;

/** Named options for an object field. */
export type DatafnObjectFieldOptions = DatafnFieldCommonOptions<
  Readonly<Record<string, unknown>>
>;

/** Named options for an array field. */
export type DatafnArrayFieldOptions = DatafnFieldCommonOptions<
  readonly unknown[]
> & {
  min?: number;
  max?: number;
};

/** Named options for a date field. */
export type DatafnDateFieldOptions = DatafnFieldCommonOptions<
  string | number
> & {
  min?: number;
  max?: number;
};

/** Named options for a file-reference field. */
export type DatafnFileFieldOptions = DatafnFieldCommonOptions<string> &
  DatafnEnumOptions<string>;

/** Named options for a JSON field. */
export type DatafnJsonFieldOptions = DatafnFieldCommonOptions<
  Exclude<DatafnJsonValue, null>
>;

/** Maps each public field kind to its accepted named options. */
export type DatafnFieldOptionsByType = {
  string: DatafnStringFieldOptions;
  number: DatafnNumberFieldOptions;
  boolean: DatafnBooleanFieldOptions;
  object: DatafnObjectFieldOptions;
  array: DatafnArrayFieldOptions;
  date: DatafnDateFieldOptions;
  file: DatafnFileFieldOptions;
  json: DatafnJsonFieldOptions;
};

type KeysOfUnion<Value> = Value extends Value ? keyof Value : never;

type StrictOptions<Options, Shape> = Options &
  Record<Exclude<keyof Options, KeysOfUnion<Shape>>, never>;

type BooleanOption<
  Options,
  Key extends "required" | "nullable",
> = Key extends keyof Options
  ? Options extends { readonly [Option in Key]-?: true }
    ? true
    : true extends Exclude<Options[Key], undefined>
      ? boolean
      : false
  : false;

type DefinedOption<Options, Key extends PropertyKey> = Key extends keyof Options
  ? [Exclude<Options[Key], undefined>] extends [never]
    ? Record<never, never>
    : undefined extends Options[Key]
      ? { readonly [Option in Key]?: Exclude<Options[Key], undefined> }
      : Options extends { readonly [Option in Key]-?: unknown }
        ? { readonly [Option in Key]: Options[Key] }
        : { readonly [Option in Key]?: Options[Key] }
  : Record<never, never>;

/** Plain field schema returned by a const-safe field builder. */
export type DatafnBuiltField<
  Name extends string,
  Type extends DatafnFieldType,
  Options extends DatafnFieldOptionsByType[Type],
> = Options extends DatafnFieldOptionsByType[Type]
  ? Omit<Options, "name" | "type" | "required" | "nullable" | "default"> &
      DefinedOption<Options, "default"> & {
        readonly name: Name;
        readonly type: Type;
        readonly required: BooleanOption<Options, "required">;
        readonly nullable: BooleanOption<Options, "nullable">;
      }
  : never;

function buildField<
  const Name extends string,
  Type extends DatafnFieldType,
  Options extends DatafnFieldOptionsByType[Type],
>(
  name: Name,
  type: Type,
  options?: Options,
): DatafnBuiltField<Name, Type, Options> {
  const values = { ...options } as Record<string, unknown>;
  if (values.default === undefined) {
    delete values.default;
  }
  return {
    ...values,
    name,
    type,
    required: values?.required ?? false,
    nullable: values?.nullable ?? false,
  } as DatafnBuiltField<Name, Type, Options>;
}

type DatafnFieldBuilder<
  Type extends DatafnFieldType,
  OptionsShape extends DatafnFieldOptionsByType[Type],
> = {
  <const Name extends string>(
    name: Name,
  ): DatafnBuiltField<Name, Type, NoFieldOptions>;
  <const Name extends string, const Options extends OptionsShape>(
    name: Name,
    options: StrictOptions<Options, OptionsShape>,
  ): DatafnBuiltField<Name, Type, Options>;
};

function createFieldBuilder<
  Type extends DatafnFieldType,
  OptionsShape extends DatafnFieldOptionsByType[Type],
>(type: Type): DatafnFieldBuilder<Type, OptionsShape> {
  return ((name: string, options?: OptionsShape) =>
    buildField(name, type, options)) as DatafnFieldBuilder<Type, OptionsShape>;
}

/**
 * Const-safe field builders. Each builder returns a plain schema object,
 * preserves inference-relevant literals, and defaults `required` and
 * `nullable` to `false`.
 */
export const field = {
  string: createFieldBuilder<"string", DatafnStringFieldOptions>("string"),
  number: createFieldBuilder<"number", DatafnNumberFieldOptions>("number"),
  boolean: createFieldBuilder<"boolean", DatafnBooleanFieldOptions>("boolean"),
  object: createFieldBuilder<"object", DatafnObjectFieldOptions>("object"),
  array: createFieldBuilder<"array", DatafnArrayFieldOptions>("array"),
  date: createFieldBuilder<"date", DatafnDateFieldOptions>("date"),
  file: createFieldBuilder<"file", DatafnFileFieldOptions>("file"),
  json: createFieldBuilder<"json", DatafnJsonFieldOptions>("json"),
} as const;
