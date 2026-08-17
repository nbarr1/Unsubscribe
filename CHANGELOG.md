# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Added

- The six architecture decision records in `docs/adr/`, covering mail access
  (ADR-001), sync model (ADR-002), interface layer (ADR-003, open), storage
  (ADR-004), sender identity (ADR-005) and suppression semantics (ADR-006).
- Repository scaffold: TypeScript in strict mode, ESLint, Prettier, Vitest with
  an enforced 90% coverage floor on `src/domain` and `src/detection`, and a
  GitHub Actions workflow running lint, format, typecheck and test.
