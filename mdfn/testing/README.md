# @mdfn/testing

Reusable preservation, rendering-security, extension, adapter-trace, official
CommonMark, fuzz, performance, mounted-framework, real-browser, SSR, runtime
export, and packed-consumer conformance helpers.

## Large-document performance budget

The large-document test builds a ~200k-character fixture and times the full
`parseMarkdown` → `serializeMarkdown` → `renderHtml` pipeline. Local development
must stay under **5s**; CI shared runners use a **20s** ceiling. Scoped GHA runs
finish in ~12s, but full-graph turbo CI (300+ tasks) was observed at ~12.1s on
PR 133, so the ceiling leaves headroom for runner contention.
