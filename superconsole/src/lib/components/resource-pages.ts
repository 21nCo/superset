import { ADMIN_API_PREFIX, fetchAdmin, materializeAdminActionHref, scopedConsoleHref, withAdminScope, type AdminFetch } from './admin-api';
import {
  inferAdminResourceColumns,
  inferAdminResourceFields,
  inferAdminResourceStatus,
  inferAdminResourceTitle,
  isAdminRecord,
  moduleById,
  normalizeAdminResourceRows,
  readAdminPresentationField,
  type AdminErrorViewModel,
  type AdminResourceViewModel,
  type RegistryViewModel,
  type ResourceDetailViewModel,
  type ResourceListViewModel,
} from './view-models';

interface ResourceRouteInput {
  fetcher: AdminFetch;
  url: URL;
  registry: RegistryViewModel;
  moduleId: string;
  resourceId: string;
  sourceModuleId?: string;
}

function resourceForRoute(
  resources: AdminResourceViewModel[] | undefined,
  resourceId: string,
  sourceModuleId?: string
): AdminResourceViewModel | undefined {
  return resources?.find((candidate) => {
    const canonicalId = candidate.resourceId ?? candidate.id;
    if (sourceModuleId) {
      return candidate.sourceModuleId?.toLowerCase() === sourceModuleId.toLowerCase()
        && canonicalId.toLowerCase() === resourceId.toLowerCase();
    }
    return candidate.id.toLowerCase() === resourceId.toLowerCase()
      || (!candidate.foldedIntoModuleId && canonicalId.toLowerCase() === resourceId.toLowerCase());
  });
}

function unavailable(resourceId: string, moduleId: string): AdminErrorViewModel {
  return {
    status: 404,
    code: 'RESOURCE_NOT_ENABLED',
    message: `${resourceId} is not an enabled ${moduleId} administration resource.`,
  };
}

function parseQueryValue(raw: string, schema: AdminResourceViewModel['listInputSchema']): unknown {
  const types = schema?.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (types.includes('null') && raw === 'null') return null;
  if (types.includes('integer') || types.includes('number')) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  if (types.includes('boolean')) return raw === 'true' ? true : raw === 'false' ? false : raw;
  if (types.includes('object') || types.includes('array')) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

function inputSchemaAtPath(
  schema: AdminResourceViewModel['listInputSchema'],
  path: string,
): AdminResourceViewModel['listInputSchema'] {
  let current = schema;
  for (const segment of path.split('.')) {
    if (!current) return undefined;
    const types = current.type ? (Array.isArray(current.type) ? current.type : [current.type]) : [];
    if (!types.includes('object')) return undefined;
    current = current.properties?.[segment];
  }
  return current;
}

function setInputPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  if (segments.some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) {
    throw new Error('Administration input paths cannot address object prototype properties.');
  }
  let current = target;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const existing = current[segment];
    if (!isAdminRecord(existing)) current[segment] = Object.create(null) as Record<string, unknown>;
    current = current[segment] as Record<string, unknown>;
  });
}

function listRequestHref(
  resource: AdminResourceViewModel,
  apiHref: string,
  searchParams: URLSearchParams,
): string {
  const requestHref = new URL(apiHref, 'http://superconsole.local');
  const schema = resource.listInputSchema;
  const input: Record<string, unknown> = {};
  for (const [key, raw] of searchParams) {
    const property = schema?.type === 'object' ? schema.properties?.[key] : undefined;
    if (property) input[key] = parseQueryValue(raw, property);
  }
  const searchPath = resource.presentation?.query?.searchInputPath
    ?? (schema?.type === 'object' && schema.properties?.search ? 'search' : undefined);
  const query = searchParams.get('q');
  if (searchPath && query) setInputPath(input, searchPath, query);
  for (const filter of resource.presentation?.query?.filters ?? []) {
    const raw = searchParams.get(filter.field);
    if (raw !== null && raw !== '') {
      setInputPath(input, filter.inputPath, parseQueryValue(raw, inputSchemaAtPath(schema, filter.inputPath)));
    }
  }
  for (const [key, value] of Object.entries(input)) {
    requestHref.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return `${requestHref.pathname}${requestHref.search}`;
}

function relatedResources(
  module: NonNullable<ReturnType<typeof moduleById>>,
  resource: AdminResourceViewModel,
  item: Record<string, unknown> | undefined,
  searchParams: URLSearchParams,
) {
  if (!item) return [];
  const canonicalResource = resource.resourceId ?? resource.id;
  return (module.resources ?? []).flatMap((candidate) => {
    const parent = candidate.presentation?.parent;
    if (!parent || parent.resourceId !== canonicalResource || candidate.sourceModuleId !== resource.sourceModuleId) return [];
    const href = new URL(candidate.href, 'http://superconsole.local');
    for (const binding of parent.bindings) {
      const value = readAdminPresentationField(item, binding.sourceField);
      if (value === undefined || value === null || value === '') return [];
      href.searchParams.set(binding.queryField, typeof value === 'string' ? value : JSON.stringify(value));
    }
    return [{
      resourceId: candidate.resourceId ?? candidate.id,
      label: candidate.pluralLabel ?? candidate.label,
      description: candidate.description,
      href: scopedConsoleHref(`${href.pathname}${href.search}`, searchParams),
    }];
  });
}

function detailInput(
  resource: AdminResourceViewModel,
  identity: string,
  searchParams: URLSearchParams
): { value?: Record<string, unknown>; missing?: string } {
  const idInput = resource.detailIdInput ?? 'id';
  const value: Record<string, unknown> = { [idInput]: identity };
  const schema = resource.detailInputSchema;
  const required = schema?.type === 'object' ? schema.required ?? [] : [];
  for (const key of required) {
    if (key === idInput) continue;
    const raw = searchParams.get(key);
    if (raw === null || raw === '') return { missing: key };
    const property = schema?.type === 'object' ? schema.properties?.[key] : undefined;
    if (!property || property.type === 'string') {
      value[key] = raw;
      continue;
    }
    try {
      value[key] = JSON.parse(raw);
    } catch {
      return { missing: key };
    }
  }
  return { value };
}

export async function loadResourceList(input: ResourceRouteInput): Promise<{
  view?: ResourceListViewModel;
  loadError?: AdminErrorViewModel;
  query: string;
}> {
  const module = moduleById(input.registry, input.moduleId);
  const resource = resourceForRoute(module?.resources, input.resourceId, input.sourceModuleId);
  if (!module || !resource) return { view: undefined, loadError: unavailable(input.resourceId, input.moduleId), query: '' };

  const apiModule = input.sourceModuleId ?? resource.sourceModuleId ?? input.moduleId;
  const canonicalResource = resource.resourceId ?? input.resourceId;
  if (resource.listable === false) {
    return { view: undefined, loadError: unavailable(input.resourceId, input.moduleId), query: '' };
  }
  const missingContext = resource.presentation?.parent?.bindings.find((binding) => !input.url.searchParams.get(binding.queryField));
  if (missingContext) {
    return {
      view: undefined,
      loadError: {
        status: 400,
        code: 'RESOURCE_CONTEXT_REQUIRED',
        message: `${missingContext.queryField} is required to browse ${resource.pluralLabel ?? resource.label}.`,
      },
      query: '',
    };
  }
  const apiHref = resource.listApiHref ?? resource.apiHref
    ?? `${ADMIN_API_PREFIX}/modules/${encodeURIComponent(apiModule)}/${encodeURIComponent(canonicalResource)}`;
  let requestHref: string;
  try {
    requestHref = listRequestHref(resource, apiHref, input.url.searchParams);
  } catch {
    return {
      view: undefined,
      loadError: {
        status: 400,
        code: 'RESOURCE_QUERY_INVALID',
        message: `The query controls for ${resource.pluralLabel ?? resource.label} are invalid.`,
      },
      query: input.url.searchParams.get('q') ?? '',
    };
  }
  const result = await fetchAdmin<Partial<ResourceListViewModel> & { items?: unknown[] }>(
    input.fetcher,
    withAdminScope(requestHref, input.url.searchParams)
  );
  const payload = result.ok ? result.data : {};
  // List operations own global ordering because cursor pagination must be sorted before slicing.
  // Preserve the provider's order unless the operation contract explicitly accepts a sort input.
  const canonicalItems = Array.isArray(payload.items) ? payload.items : [];
  const explicitRows = Array.isArray(payload.rows) ? payload.rows : undefined;
  const columnSource = explicitRows?.map((row) => ({ values: row.values })) ?? canonicalItems;
  const columns = resource.presentation?.columns?.length
    ? resource.presentation.columns.map((column) => ({ key: column.field, label: column.label, format: column.format }))
    : Array.isArray(payload.columns) && payload.columns.length
    ? payload.columns
    : inferAdminResourceColumns(columnSource);
  return {
    view: {
      module,
      resource,
      columns,
      rows: explicitRows ?? normalizeAdminResourceRows(canonicalItems, columns, resource),
      total: payload.total,
      nextCursor: payload.nextCursor ?? (result.ok ? result.page?.nextCursor ?? undefined : undefined),
      searchEnabled: Boolean(resource.presentation?.query?.searchInputPath
        ?? (resource.listInputSchema?.type === 'object' && resource.listInputSchema.properties?.search)),
      filters: (resource.presentation?.query?.filters ?? []).map((filter) => ({
        field: filter.field,
        label: filter.label ?? filter.field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase()),
        value: input.url.searchParams.get(filter.field) ?? '',
        options: filter.options,
      })),
    },
    loadError: result.ok ? undefined : result.error,
    query: input.url.searchParams.get('q') ?? '',
  };
}

export async function loadResourceDetail(
  input: ResourceRouteInput & { identity: string }
): Promise<{ view?: ResourceDetailViewModel; loadError?: AdminErrorViewModel }> {
  const module = moduleById(input.registry, input.moduleId);
  const resource = resourceForRoute(module?.resources, input.resourceId, input.sourceModuleId);
  if (!module || !resource) return { view: undefined, loadError: unavailable(input.resourceId, input.moduleId) };

  const apiModule = input.sourceModuleId ?? resource.sourceModuleId ?? input.moduleId;
  const canonicalResource = resource.resourceId ?? input.resourceId;
  const detailTemplate = resource.detailApiHref;
  if (!detailTemplate) return { view: undefined, loadError: unavailable(input.resourceId, input.moduleId) };
  const operationInput = detailInput(resource, input.identity, input.url.searchParams);
  if (!operationInput.value) {
    return {
      view: undefined,
      loadError: {
        status: 400,
        code: 'RESOURCE_DETAIL_INPUT_REQUIRED',
        message: `${operationInput.missing ?? 'A required identifier'} is required to load this ${canonicalResource} detail.`,
      },
    };
  }
  const method = resource.detailApiMethod ?? 'GET';
  const base = materializeAdminActionHref(detailTemplate, operationInput.value, method);
  if (!base) return { view: undefined, loadError: unavailable(input.resourceId, input.moduleId) };
  const result = await fetchAdmin<Partial<ResourceDetailViewModel> & { item?: unknown }>(
    input.fetcher,
    withAdminScope(base, input.url.searchParams),
    method === 'GET'
      ? undefined
      : { method, body: JSON.stringify(operationInput.value) },
  );
  const payload = result.ok ? result.data : {};
  const itemRecord = isAdminRecord(payload.item) ? payload.item : undefined;
  const presentation = resource.presentation;
  const fieldValue = (field: string | undefined): unknown =>
    field && itemRecord ? readAdminPresentationField(itemRecord, field) : undefined;
  const presentedTitle = fieldValue(presentation?.titleField);
  const presentedSubtitle = fieldValue(presentation?.subtitleField);
  const presentedStatus = fieldValue(presentation?.statusField);
  const presentedFields = presentation?.columns?.map((column) => ({
    label: column.label,
    value: fieldValue(column.field),
    format: column.format,
  }));
  return {
    view: {
      module,
      resource,
      id: input.identity,
      title: typeof presentedTitle === 'string' || typeof presentedTitle === 'number'
        ? String(presentedTitle)
        : payload.title ?? inferAdminResourceTitle(itemRecord, input.identity),
      subtitle: typeof presentedSubtitle === 'string'
        ? presentedSubtitle
        : payload.subtitle ?? (typeof itemRecord?.description === 'string' ? itemRecord.description : undefined),
      status: typeof presentedStatus === 'string'
        ? presentedStatus
        : payload.status ?? inferAdminResourceStatus(itemRecord),
      fields: presentedFields?.length
        ? presentedFields
        : Array.isArray(payload.fields) ? payload.fields : inferAdminResourceFields(itemRecord),
      actions: (resource.actions ?? []).filter((action) => Boolean(action.targetIdInput)).map((action) => ({
        ...action,
        input: { ...(action.input ?? {}), [action.targetIdInput!]: input.identity },
      })),
      related: relatedResources(module, resource, itemRecord, input.url.searchParams),
      audit: Array.isArray(payload.audit) ? payload.audit : [],
    },
    loadError: result.ok ? undefined : result.error,
  };
}
