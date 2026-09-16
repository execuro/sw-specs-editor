# Changelog

All notable changes to `@execuro-sw-ecosystem/sw-specs-editor`.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- First packaged release. Previously an internal tool inside a Shopware
  agentic harness; now a standalone repository and npm package.
- `skills/sw-specs-editor/SKILL.md` — the stub skill, shipped in the package and
  installed into a host by `sw-specs-editor install-skill`.
- `lib/paths.mjs` — project-root resolution by walk-up from the document, so the
  CLI no longer depends on the caller's working directory.
- MIT `LICENSE`, `THIRD-PARTY-NOTICES.md`, consumer `README.md`.
- Tag-driven release: pushing `v<version>` publishes to npm from GitHub Actions
  with `--provenance`, authenticated by OIDC trusted publishing. No npm token
  is stored in this repository.
- `scripts/check-version.mjs` — refuses a release whose shipped skill pins a
  different CLI version than `package.json` declares.

[Unreleased]: https://github.com/execuro/sw-specs-editor/compare/v0.1.0...HEAD
