# Changelog

All notable changes to the Iwosan API (the NestJS backend and `@iwosan/sdk`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **Iwosan marketplace listings API** (`src/marketplace`): catalogue for medical equipment sale and rental, orthodox and native drugs, and medical personnel hire, with admin verification for drug and personnel listings ([#1](https://github.com/Iwosan/Iwosan_api/pull/1)).
- **Stellar ecosystem roadmap** (`docs/STELLAR_ROADMAP.md`) and roadmap issues #2–#11 ([#12](https://github.com/Iwosan/Iwosan_api/pull/12)).

### Changed
- Project renamed to **Iwosan** across packages, the SDK, configuration, metrics, docs and Postman collections ([#1](https://github.com/Iwosan/Iwosan_api/pull/1)).

### Fixed
- Restored a truncated `src/app.module.ts` so the application compiles again ([#1](https://github.com/Iwosan/Iwosan_api/pull/1)).

### Removed
- Leftover per-PR notes and legacy references in docs.
