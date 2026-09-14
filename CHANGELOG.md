# Changelog
All notable changes to `claudegravity-loop` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.1] - 2026-09-14

### Added
- **GitHub Actions CI Aggregator**: Added dedicated `test-on-node` aggregator job named `"Test on Node"` to `.github/workflows/ci.yml` to satisfy repository branch protection rulesets without manual adjustments.
- **Dual-Locale Arithmetic Parsing**: Implemented formal dual-locale (US/EU) parsing in `runPreflightLinter` supporting period thousands separators (`1.200 + 300 = 1.500`) and full European decimals (`1.200,50 + 300 = 1.500,50`).
- **Equation Segmentation Isolation**: Preflight consistency linter isolates equation segments once, preventing false positives from prefix tokens and false negatives from non-linear skips (`1080x1920`, dates).
- **Linter Escape Hatch (`--skip-lint`)**: Added `--skip-lint` flag to `scripts/runner.mjs` allowing reviews to proceed when intentional or unstructured math is present, logging suppressed errors in `PLAN-REVIEW-LOG.md`.
- **Antigravity CLI Timeout Intercept**: Runner injects `--print-timeout <timeout - 15>s` to `agy` and intercepts `/print timeout after/i` in `stderr`, treating partial timeout returns as exit code 124 rather than exit 0.
- **Fallback On Timeout Opt-In (`--fallback-on-timeout`)**: Decoupled model fallback from execution timeouts; timeouts exit with code 124 by default unless `--fallback-on-timeout` is provided.
- **Skill Frontmatter Validation**: `scripts/validate.mjs` validates YAML frontmatter (`---`, matching `name:`, non-empty `description:`) across all declared skills.
- **Windows Executable Preference**: `getExecutable` prioritizes native `.exe` binaries over npm batch shims (`.cmd`, `.bat`, extensionless), and `preflight` clearly warns when only shims are detected.
- **Complete Structured Extraction**: `extractStructuredArtifact` extracts all shapes and text nodes without blind slicing, decodes XML entities, handles element attributes, and accepts presentation XML for slide dimensions.

### Changed
- **Behavior Changes**:
  - Unrecognized flags or options missing required values now immediately exit with code 1 and display usage instructions instead of being silently ignored.
  - Default runner timeout increased from 120 seconds to 600 seconds (10 minutes).
  - `--rounds` is formally deprecated and ignored with a warning (single round per CLI invocation to allow host arbitration in `PLAN-REVIEW-LOG.md`).
- **Track Detection**: `detectTrack` now requires explicit path indicators (`/`, `\`, backticks) or build/test commands, eliminating false positive code classifications on prose documents.
- **Dynamic Versioning**: Runner and benchmark suites dynamically synchronize version strings from `package.json`.
- **Documentation**: Corrected global skill installation instructions for "Method B" in `README.md` and added `--tools ""` to direct `claude -p` invocation examples in `SKILL.md`.

---

## [1.1.0] - 2026-09-14

### Added
- **Zero-Dependency Native Runner (`scripts/runner.mjs`)**: Standard library async CLI runner supporting streaming stdin pipe, preflight consistency linter, and bounded model fallbacks.
- **Win32 Boundary Elimination**: Replaced argv payload passing with asynchronous streaming `stdin` pipe, supporting 100 KB+ plans without Windows `CreateProcess` 32,767 character limits.
- **Scoped TLS Invariant**: Default-secure TLS verification with opt-in `--insecure-tls` flag for corporate proxy traversal; case-insensitive scrubbing of `NODE_TLS_REJECT_UNAUTHORIZED`.
- **Deterministic 1-Hop Fallback**: Provider-aware fallback (Claude Opus $\rightarrow$ Sonnet; Antigravity Pro $\rightarrow$ Flash) bounded to a single hop upon CBRN/policy/rate limits.
- **Pre-flight Consistency Linter**: Multi-operand arithmetic validator, unit budget validator, and code fence closure checker.
- **Dual-Track Workflow**: Support for Codebase (Git Worktrees + `PROOF_CMD`) and Structured Artifacts (PowerPoint, PDF, diagram extraction).
- **Empirical Benchmark Suite (`scripts/benchmark.mjs`)**: 5 automated deterministic benchmark tests validating stability, security, resilience, efficiency, and token reduction.
