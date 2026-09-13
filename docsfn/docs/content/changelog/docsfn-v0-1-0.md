---
title: Docsfn v0.1.0 Changelog Foundation
date: "2026-07-10"
tags:
  - changelog
  - docsfn
excerpt: First-class changelog collections now use the shared dated-content engine without pretending to be blog posts.
---

# Docsfn v0.1.0 Changelog Foundation

This update adds the first production-grade foundation for changelog content in docsfn.

- Changelog entries can live in `content/changelog`.
- Public routes can be served from `/changelog`.
- Search can index changelog entries under the `changelog` scope.
- RSS can be generated for changelog separately from blog posts.

The underlying dated-content engine is reused, but the public model is now a named collection instead of a fake blog configuration.
