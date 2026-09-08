import { describe, expect, it, vi } from 'vitest';
import { loadResourceDetail, loadResourceList } from '../../src/lib/components/resource-pages';
import { normalizeAdminResourceRows, type RegistryViewModel } from '../../src/lib/components/view-models';

const registry: RegistryViewModel = {
  modules: [{
    id: 'examplefn',
    name: 'ExampleFn',
    description: 'Example resources.',
    href: '/modules/examplefn',
    enabled: true,
    resources: [{
      id: 'records',
      resourceId: 'records',
      sourceModuleId: 'examplefn',
      idField: 'id',
      label: 'Records',
      href: '/modules/examplefn/records',
      listApiHref: '/api/admin/v1/modules/examplefn/resources/records',
      presentation: {
        columns: [{ field: 'createdAt', label: 'Created' }],
        defaultSort: { field: 'createdAt', direction: 'desc' },
      },
    }],
  }],
};

describe('generic resource list ordering', () => {
  it('preserves provider ordering for canonical items and explicit rows', async () => {
    const payloads = [
      { items: [{ id: 'provider-first', createdAt: '2024-01-01' }, { id: 'provider-second', createdAt: '2026-01-01' }] },
      { rows: [{ id: 'explicit-first', values: { createdAt: '2024-01-01' } }, { id: 'explicit-second', values: { createdAt: '2026-01-01' } }] },
    ];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: payloads.shift() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const input = {
      fetcher,
      url: new URL('https://console.example.test/modules/examplefn/records'),
      registry,
      moduleId: 'examplefn',
      resourceId: 'records',
    };

    const canonical = await loadResourceList(input);
    const explicit = await loadResourceList(input);

    expect(canonical.view?.rows.map((row) => row.id)).toEqual(['provider-first', 'provider-second']);
    expect(explicit.view?.rows.map((row) => row.id)).toEqual(['explicit-first', 'explicit-second']);
  });

  it('maps declared controls into the list schema and drops unsupported query input', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ ok: true, data: { items: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const mappedRegistry: RegistryViewModel = {
      modules: [{
        ...registry.modules[0]!,
        resources: [{
          ...registry.modules[0]!.resources![0]!,
          listInputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'integer' },
              filter: {
                type: 'object',
                properties: {
                  status: { type: 'string' },
                  enabled: { type: 'boolean' },
                  retries: { type: 'integer' },
                  cleared: { type: ['string', 'null'] },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
          presentation: {
            query: { filters: [
              { field: 'status', inputPath: 'filter.status', label: 'Status', options: ['running', 'success'] },
              { field: 'enabled', inputPath: 'filter.enabled', options: [true, false] },
              { field: 'retries', inputPath: 'filter.retries' },
              { field: 'cleared', inputPath: 'filter.cleared', options: [null] },
            ] },
          },
        }],
      }],
    };

    const loaded = await loadResourceList({
      fetcher,
      url: new URL('https://console.example.test/modules/examplefn/records?q=ignored&status=running&enabled=false&retries=3&cleared=null&limit=25&unsupported=value'),
      registry: mappedRegistry,
      moduleId: 'examplefn',
      resourceId: 'records',
    });

    const requested = new URL(String(fetcher.mock.calls[0]![0]), 'https://console.example.test');
    expect(requested.searchParams.get('filter')).toBe(JSON.stringify({
      status: 'running', enabled: false, retries: 3, cleared: null,
    }));
    expect(requested.searchParams.get('limit')).toBe('25');
    expect(requested.searchParams.has('q')).toBe(false);
    expect(requested.searchParams.has('unsupported')).toBe(false);
    expect(loaded.view?.searchEnabled).toBe(false);
    expect(loaded.view?.filters).toEqual(expect.arrayContaining([
      { field: 'status', label: 'Status', value: 'running', options: ['running', 'success'] },
      { field: 'enabled', label: 'Enabled', value: 'false', options: [true, false] },
      { field: 'retries', label: 'Retries', value: '3', options: undefined },
      { field: 'cleared', label: 'Cleared', value: 'null', options: [null] },
    ]));
  });

  it('returns an admin error view for reserved query input paths', async () => {
    const fetcher = vi.fn();
    const guardedRegistry: RegistryViewModel = {
      modules: [{
        ...registry.modules[0]!,
        resources: [{
          ...registry.modules[0]!.resources![0]!,
          listInputSchema: { type: 'object', properties: { filter: { type: 'object' } } },
          presentation: { query: { filters: [{ field: 'status', inputPath: '__proto__.status' }] } },
        }],
      }],
    };

    const loaded = await loadResourceList({
      fetcher,
      url: new URL('https://console.example.test/modules/examplefn/records?status=running'),
      registry: guardedRegistry,
      moduleId: 'examplefn',
      resourceId: 'records',
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(loaded.loadError).toMatchObject({ status: 400, code: 'RESOURCE_QUERY_INVALID' });
  });

  it('builds parent-bound related resource links from generic detail records', async () => {
    const contextualRegistry: RegistryViewModel = {
      modules: [{
        id: 'cifn',
        name: 'CiFn',
        description: 'CI resources.',
        href: '/modules/cifn',
        enabled: true,
        resources: [
          {
            id: 'runs', resourceId: 'runs', sourceModuleId: 'cifn', label: 'Runs', href: '/modules/cifn/runs',
            detailApiHref: '/api/admin/v1/modules/cifn/runs/:id', detailIdInput: 'id',
          },
          {
            id: 'jobs', resourceId: 'jobs', sourceModuleId: 'cifn', label: 'Jobs', href: '/modules/cifn/jobs',
            presentation: {
              parent: { resourceId: 'runs', bindings: [{ sourceField: 'runId', queryField: 'runId' }] },
            },
          },
          {
            id: 'artifacts', resourceId: 'artifacts', sourceModuleId: 'cifn', label: 'Artifacts', href: '/modules/cifn/artifacts',
            presentation: {
              parent: { resourceId: 'runs', bindings: [{ sourceField: 'runId', queryField: 'runId' }] },
            },
          },
        ],
      }],
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { item: { runId: 'run_1', status: 'running' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const loaded = await loadResourceDetail({
      fetcher,
      url: new URL('https://console.example.test/modules/cifn/runs/run_1?environmentId=env_1'),
      registry: contextualRegistry,
      moduleId: 'cifn',
      resourceId: 'runs',
      identity: 'run_1',
    });

    expect(loaded.view?.related).toEqual([
      expect.objectContaining({ resourceId: 'jobs', href: '/modules/cifn/jobs?runId=run_1&environmentId=env_1' }),
      expect.objectContaining({ resourceId: 'artifacts', href: '/modules/cifn/artifacts?runId=run_1&environmentId=env_1' }),
    ]);
  });

  it('sends POST detail inputs in the request body instead of the URL', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true,
      data: { item: { uploadSessionId: 'upload_1' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const registry: RegistryViewModel = {
      modules: [{
        id: 'filefn', name: 'FileFn', description: 'Files.', href: '/modules/filefn', enabled: true,
        resources: [{
          id: 'upload-sessions', resourceId: 'upload-sessions', sourceModuleId: 'filefn',
          label: 'Upload sessions', href: '/modules/filefn/upload-sessions',
          detailApiHref: '/api/admin/v1/modules/filefn/resources/upload-sessions/:id',
          detailApiMethod: 'POST', detailIdInput: 'id',
        }],
      }],
    };

    await loadResourceDetail({
      fetcher,
      url: new URL('https://console.example.test/modules/filefn/upload-sessions/upload_1'),
      registry,
      moduleId: 'filefn',
      resourceId: 'upload-sessions',
      identity: 'upload_1',
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('/api/admin/v1/modules/filefn/resources/upload-sessions/upload_1');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ id: 'upload_1' }) });
  });

  it('binds required action inputs that are present on each canonical row', () => {
    const rows = normalizeAdminResourceRows(
      [{ id: 'artifact_1', runId: 'run_1', name: 'report.zip' }],
      [{ key: 'name', label: 'Artifact' }],
      {
        id: 'artifacts', label: 'Artifacts', href: '/modules/cifn/artifacts',
        actions: [{
          id: 'cifn.artifacts.download-artifact', label: 'Download', targetIdInput: 'id',
          inputSchema: {
            type: 'object', properties: { id: { type: 'string' }, runId: { type: 'string' } },
            required: ['id', 'runId'], additionalProperties: false,
          },
        }],
      },
    );

    expect(rows[0]?.actions?.[0]?.input).toEqual({ id: 'artifact_1', runId: 'run_1' });
  });
});
