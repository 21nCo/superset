# SvelteKit Hybrid Site Example

This example demonstrates the exact consumer shape that comes up most often:

- a custom landing page at `/`
- docs sections under `/docs/...` with different sidebars
- a dedicated OpenAPI route at `/docs/api/...`
- blog routes under `/blog/...`
- standalone markdown pages from `content/pages` such as `/help/faq` and `/legal/privacy`

## Why this example exists

It shows how to keep the integration thin:

- plain docs pages use `resolveDocsRouteDataOrThrow()` + `resolveDocsPageSurface()`
- OpenAPI pages use `loadApiData()` in a dedicated route, instead of mixing `page` and `api` handling in one catch-all loader
- local app code imports published package names like `@docsfn/core` and `@docsfn/sveltekit`, with no docsfn source aliases
- UI rendering uses the packaged `@docsfn/svelte` components directly

## Routes to try

- `/`
- `/docs`
- `/docs/product`
- `/docs/platform`
- `/docs/api/commerce`
- `/blog`
- `/help/faq`
- `/legal/privacy`

## Run

```bash
npm install --prefix docsfn/examples/sveltekit-hybrid-site
npm --prefix docsfn/examples/sveltekit-hybrid-site run dev
```
