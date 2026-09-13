/**
 * Adapter factory for creating and wrapping adapters
 */

import { mergeCapabilities } from './capabilities.js';
import type {
  Adapter,
  AdapterFactoryConfig,
  AdapterFactoryOptions,
  AdapterContext,
  AdapterImplementation,
  LibraryOptions,
  Logger,
} from './types.js';
import {  NamespaceManager } from '../utils/namespace.js';
import {
  transformRecordForRuntime,
  transformRecordForStorage,
  transformWhereForStorage,
} from './schema-codecs.js';

/**
 * Create an adapter factory that wraps adapter implementations with
 * automatic features like namespacing, transformations, and logging
 */
export function createAdapterFactory(
  options: AdapterFactoryOptions
): (libraryOptions: LibraryOptions) => Adapter {
  const { config, adapter: createAdapter } = options;

  return (libraryOptions: LibraryOptions): Adapter => {
    // Build context for the adapter
    const context = buildAdapterContext(config, libraryOptions);

    // Create the implementation
    const implementation = createAdapter(context);

    // Wrap with factory enhancements
    return wrapAdapter(implementation, context, config);
  };
}

/**
 * Build adapter context with helper functions and configuration
 */
function buildAdapterContext(
  config: AdapterFactoryConfig,
  libraryOptions: LibraryOptions
): AdapterContext {
  const namespace = libraryOptions.namespace ?? 'default';
  const schema = libraryOptions.schema ?? {};

  // Create namespace manager
  const namespaceManager = new NamespaceManager({
    enabled: config.namespace?.enabled ?? false,
    separator: config.namespace?.separator ?? '_',
    prefix: config.namespace?.prefix,
    schemaSupport: config.namespace?.schemaSupport ?? false,
  });

  // Logger setup
  const logger: Logger = createLogger(config.debug);

  return {
    options: libraryOptions,
    schema,

    // Model name helpers
    getModelName: (model: string) => {
      const tableName = config.usePlural ? pluralize(model) : model;
      return namespaceManager.isEnabled()
        ? namespaceManager.apply(namespace, tableName)
        : tableName;
    },

    getDefaultModelName: (model: string) => {
      return config.usePlural ? pluralize(model) : model;
    },

    // Field name helpers
    getFieldName: ({ model, field }) => {
      const fieldSchema = Object.prototype.hasOwnProperty.call(schema, model) ? schema[model]?.fields[field] : undefined;
      return fieldSchema?.fieldName ?? field;
    },

    getDefaultFieldName: ({ field }) => {
      return field;
    },

    // Data transformers
    transformInput: async (data, _model, action) => {
      let transformed = { ...data };

      // Apply key mapping (e.g., id -> _id for MongoDB)
      if (config.mapKeysInput) {
        for (const [from, to] of Object.entries(config.mapKeysInput)) {
          if (from in transformed) {
            transformed[to] = transformed[from];
            delete transformed[from];
          }
        }
      }

      // Custom ID generation
      if (
        action === 'create' &&
        config.customIdGenerator &&
        !config.disableIdGeneration &&
        !transformed.id
      ) {
        transformed.id = config.customIdGenerator();
      }

      return transformRecordForStorage(schema, _model, transformed);
    },

    transformOutput: async (data, _model) => {
      if (!data) return data;

      let transformed = { ...data };

      // Apply key mapping (e.g., _id -> id for MongoDB)
      if (config.mapKeysOutput) {
        for (const [from, to] of Object.entries(config.mapKeysOutput)) {
          if (from in transformed) {
            transformed[to] = transformed[from];
            delete transformed[from];
          }
        }
      }

      return transformRecordForRuntime(schema, _model, transformed);
    },

    log: logger,
  };
}

/**
 * Wrap adapter implementation with factory enhancements
 */
function wrapAdapter(
  implementation: AdapterImplementation,
  context: AdapterContext,
  config: AdapterFactoryConfig
): Adapter {
  const capabilities = mergeCapabilities(config.capabilities ?? {});

  return {
    // Metadata
    id: config.adapterId,
    name: config.adapterName ?? config.adapterId,
    version: '1.0.0',
    capabilities,

    // CRUD operations with transformation
    async create(params) {
      context.log.debug('create', params);
      const transformed = await context.transformInput(params.data, params.model, 'create');
      const result = await implementation.create({ ...params, data: transformed });
      return context.transformOutput(result, params.model);
    },

    async findOne(params) {
      context.log.debug('findOne', params);
      const result = await implementation.findOne({
        ...params,
        where: transformWhereForStorage(context.schema, params.model, params.where) ?? params.where,
      });
      return result ? context.transformOutput(result, params.model) : null;
    },

    async findMany(params) {
      context.log.debug('findMany', params);
      const results = await implementation.findMany({
        ...params,
        where: transformWhereForStorage(context.schema, params.model, params.where) ?? params.where,
      });
      return Promise.all(results.map((r) => context.transformOutput(r, params.model)));
    },

    async update(params) {
      context.log.debug('update', params);
      const transformed = await context.transformInput(params.data, params.model, 'update');
      const result = await implementation.update({
        ...params,
        where: transformWhereForStorage(context.schema, params.model, params.where) ?? params.where,
        data: transformed,
      });
      return context.transformOutput(result, params.model);
    },

    async delete(params) {
      context.log.debug('delete', params);
      return implementation.delete({
        ...params,
        where: transformWhereForStorage(context.schema, params.model, params.where) ?? params.where,
      });
    },

    // Batch operations
    async createMany(params) {
      context.log.debug('createMany', params);
      const transformed = await Promise.all(
        params.data.map((d) => context.transformInput(d, params.model, 'create'))
      );
      const results = await implementation.createMany({ ...params, data: transformed });
      return Promise.all(results.map((r) => context.transformOutput(r, params.model)));
    },

    async updateMany(params) {
      context.log.debug('updateMany', params);
      const transformed = await context.transformInput(params.data, params.model, 'update');
      return implementation.updateMany({
        ...params,
        where: transformWhereForStorage(context.schema, params.model, params.where) ?? params.where,
        data: transformed,
      });
    },

    async deleteMany(params) {
      context.log.debug('deleteMany', params);
      return implementation.deleteMany({
        ...params,
        where: transformWhereForStorage(context.schema, params.model, params.where) ?? params.where,
      });
    },

    // Advanced operations
    async upsert(params) {
      context.log.debug('upsert', params);
      const transformedCreate = await context.transformInput(
        params.create,
        params.model,
        'create'
      );
      const transformedUpdate = await context.transformInput(
        params.update,
        params.model,
        'update'
      );
      const result = await implementation.upsert({
        ...params,
        where: transformWhereForStorage(context.schema, params.model, params.where) ?? params.where,
        create: transformedCreate,
        update: transformedUpdate,
      });
      return context.transformOutput(result, params.model);
    },

    async count(params) {
      context.log.debug('count', params);
      return implementation.count({
        ...params,
        where: transformWhereForStorage(context.schema, params.model, params.where) ?? params.where,
      });
    },

    // Transaction support
    async transaction(callback) {
      context.log.debug('transaction');
      return implementation.transaction(callback);
    },

    // Lifecycle
    async initialize() {
      context.log.info('Initializing adapter');
      return implementation.initialize();
    },

    async isHealthy() {
      return implementation.isHealthy();
    },

    async close() {
      context.log.info('Closing adapter');
      return implementation.close();
    },

    // Schema management
    async getSchemaVersion(namespace: string) {
      return implementation.getSchemaVersion(namespace);
    },

    async setSchemaVersion(namespace: string, version: number) {
      return implementation.setSchemaVersion(namespace, version);
    },

    async validateSchema(schema) {
      return implementation.validateSchema(schema);
    },

    // Optional schema creation
    createSchema: implementation.createSchema
      ? async (params) => implementation.createSchema!(params)
      : undefined,

    // Internal CRUD placeholder — overridden by each adapter via Object.assign
    internal: {
      ensureTable: async () => { throw new Error('InternalCrud not implemented by this adapter'); },
      create: async () => { throw new Error('InternalCrud not implemented by this adapter'); },
      findOne: async () => { throw new Error('InternalCrud not implemented by this adapter'); },
      findMany: async () => { throw new Error('InternalCrud not implemented by this adapter'); },
      update: async () => { throw new Error('InternalCrud not implemented by this adapter'); },
      delete: async () => { throw new Error('InternalCrud not implemented by this adapter'); },
    } as any,
  };
}

/**
 * Create logger based on debug configuration
 */
function createLogger(
  debug?: boolean | { logQueries?: boolean; logResults?: boolean; logTransactions?: boolean }
): Logger {
  const isDebug = typeof debug === 'boolean' ? debug : debug?.logQueries ?? false;

  const noop = () => {};

  if (!isDebug) {
    return {
      debug: noop,
      info: noop,
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
  }

  return {
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
}

/**
 * Simple pluralize helper
 */
function pluralize(word: string): string {
  if (word.endsWith('y') && !word.endsWith('ay') && !word.endsWith('ey') && !word.endsWith('oy') && !word.endsWith('uy')) {
    return word.slice(0, -1) + 'ies';
  }
  if (word.endsWith('s') || word.endsWith('x') || word.endsWith('z') || word.endsWith('ch') || word.endsWith('sh')) {
    return word + 'es';
  }
  return word + 's';
}
