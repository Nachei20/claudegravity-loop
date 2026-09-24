# Changelog
All notable changes to `claudegravity-loop` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-09-18

### Added
- **Strict CI Workflow Whitelist Validation**: `scripts/validate.mjs` enforces a strict whitelist of approved jobs (`test` matrix and `test-on-node` aggregator) in `.github/workflows/ci.yml`. Enforces that test commands cannot be chained with bypasses (`; exit 0`, `|| true`), forbids `continue-on-error`, restricts step-level `if:` conditions, and validates tamper-resistance against 13 negative fixtures.
- **Skill Description Limit**: Enforces a 1024-character maximum length on skill descriptions in `scripts/validate.mjs` to maintain compatibility with agent CLI registries.
- **CLI Precedence & Contract Enforcement**: `parseArgs` in `scripts/runner.mjs` enforces strict argument evaluation order: unknown subcommands and missing command errors exit with code 1 before evaluating global `--help`, while subcommand flag errors (e.g. `review --bogus --help` or `review --plan --help`) exit with code 1 before displaying usage.
- **Scoped `-` Operator in Preflight Linter**: Equation segmentation in `extractEquationSegment` treats `-` as a term-connecting operator only when adjacent to recognized budget units (`cm`, `mm`, `px`, `pt`, `%`) and preceded by a non-digit character. Prevents false positive cuts on ranges (`Columns 3 - 4`, `Márgenes 1-2cm`, `1 - 2cm`) and ISO dates (`Sprint 2026-09-14`).
- **Safe XML Entity Decoding**: `decodeXmlEntities` validates code point ranges (`0 < cp <= 0x10FFFF && !(0xD800 <= cp <= 0xDFFF)`), eliminating `RangeError` on invalid numeric entities (`&#x110000;`, `&#99999999;`), preserving surrogates (`&#xD800;`) and unmapped named entities (`&foo;`), and preserving `&#0;` / `&#x0;` literally to eliminate NUL byte injection.
- **Windows npm Shim Resolution**: Pure function `resolveNpmShim` resolves Windows npm shims (`.cmd`, `.bat`, and extensionless shims with `.cmd` or `sh` siblings) directly via `node.exe` with `{ shell: false }`, preventing `cmd.exe` command injection. Supports `nvm4w` junctions and directory symlinks via `realpathSync` containment checks and rejects path traversal attempts (`..\..\evil.js`).
- **Preflight Diagnostics Shim Status**: `runner.mjs preflight` displays detailed resolution diagnostics for Windows shims (`⚠️ npm shim (resolved via node: <entry>)` for resolvable shims vs `❌ unsupported shim` for unresolvable shims).
- **Refined Track Detection**: `detectTrack` requires directory path separators (`/` or `\`) or explicit build/test commands to qualify file extensions as code indicators. Prevents presentation plans mentioning bare filenames (e.g. `` `test.py` `` or `` `Node.js` ``) from being misclassified as code tracks.

### Changed
- **Installation & Documentation**: Added official support for `agy plugin import <path>` for Google Antigravity 1.2.x, bundled plugin updates, and documented the `--skip-lint` escape hatch for subtraction expressions containing intermediate textual labels.
- **Version Synchronization**: Synchronized package version to 1.2.0 across `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `scripts/runner.mjs`, and `scripts/benchmark.mjs`.

---

## [1.1.1] - 2026-09-14

### Added
- **GitHub Actions CI Aggregator**: Added dedicated `test-on-node` aggregator job named `"Test on Node"` to `.github/workflows/ci.yml` with strict success requirement (`needs.test.result == "success"`) to satisfy repository branch protection rulesets without manual adjustments.
- **Dual-Locale Arithmetic Parsing**: Implemented formal dual-locale (US/EU) parsing in `runPreflightLinter` supporting period thousands separators (`1.200 + 300 = 1.500`) and full European decimals (`1.200,50 + 300 = 1.500,50`).
- **Equation Segmentation Isolation**: Preflight consistency linter cuts at the last colon whose prefix contains no term-connecting arithmetic operators (`+` or `-`), resolving labeled equations (e.g. `Column 2 (40cm): ...`, `Poster 90cm: ...`, `Layout: col A: ...`) without false positives.
- **Calculated Sums in Diagnostics**: Restored calculated sums in linter error reporting (`calculated X != declared Y`) for both unit budgets and general equations.
- **Linter Escape Hatch (`--skip-lint`)**: Added `--skip-lint` flag to `scripts/runner.mjs` allowing reviews to proceed when intentional or unstructured math is present, logging bypassed status and suppressed errors in `PLAN-REVIEW-LOG.md`.
- **Antigravity CLI Timeout Intercept**: Runner injects `--print-timeout <timeout - 15>s` to `agy` and intercepts `/print timeout after/i` in `stderr`, treating partial timeout returns as exit code 124 rather than exit 0.
- **Fallback On Timeout Opt-In (`--fallback-on-timeout`)**: Decoupled model fallback from execution timeouts; timeouts exit with code 124 by default unless `--fallback-on-timeout` is provided.
- **Runner Timeout Guarantee**: `executeReviewerAsync` guarantees process termination via a grace period and stdio destruction upon timeout expiration, preventing hanging runs when child processes inherit open stdio pipes.
- **Skill Frontmatter & Description Validation**: `scripts/validate.mjs` validates YAML frontmatter (`---`, matching `name:`, non-empty `description:` including block scalars) across all declared skills, verified with negative fixtures.
- **Windows Executable Preference & Shim Detection**: `pickExecutable` prioritizes native `.exe` binaries over npm batch shims (`.cmd`, `.bat`, extensionless), tested against pure fixtures; `isWindowsShim` is immune to directory paths containing dots (`john.doe`).
- **Single-Pass XML Entity Decoding**: `decodeXmlEntities` performs single-pass regex replacement preventing double-decoding (e.g. `&amp;lt;b&amp;gt;` $\rightarrow$ `&lt;b&gt;`) and decoding numeric entities (`&#233;`, `&#x...;`).
- **Complete Structured Extraction**: `extractStructuredArtifact` extracts all shapes and text nodes without blind slicing, decodes XML entities, returns `null` for slide dimensions when presentation XML is absent, and handles presentation slide sizes.

### Changed
- **Behavior Changes**:
  - CLI commands and options strictly validated: unknown commands, missing commands, and unexpected positional arguments exit immediately with code 1 and usage instructions. Only `help`, `--help`, and `-h` exit with code 0.
  - Default runner timeout increased from 120 seconds to 600 seconds (10 minutes).
  - `--rounds` is formally deprecated and ignored with a warning (single round per CLI invocation to allow host arbitration in `PLAN-REVIEW-LOG.md`).
- **Track Detection**: `detectTrack` requires explicit path indicators (`/`, `\`, backticks) or build/test commands, eliminating false positive code classifications on prose documents.
- **Documentation**: Accurately documented runtime-specific global skill discovery directories (`~/.claude/skills/` for Claude Code vs `~/.agents/skills/` for Antigravity `agy`) in `README.md`.
- **Dynamic Versioning**: Runner and benchmark suites dynamically synchronize version strings from `package.json`.

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
