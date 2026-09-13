export const registryPackage = {
  name: '@uifn/registry',
  layer: 'registry',
  status: 'ga-candidate',
  sourcePolicy: 'clean-room',
} as const;

export * from './add';
export * from './build-registry';
export * from './cli';
export * from './diagnostics';
export * from './diff';
export * from './lockfile';
export * from './plan';
export * from './remove';
export * from './schema';
export * from './transaction';
export * from './trust';
export * from './update';
export * from './preset';
export {
  EXPECTED_COMPONENTS,
  EXPECTED_HOOKS,
  validateCatalog,
  type CatalogValidationResult,
} from './validate-catalog';
