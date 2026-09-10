# Context Document Format (`CONTEXT.md`)

Used in **Phase 0 (Recon)** to pin down technical facts and assumptions before designing any plan.

---

## Technical Context & Invariants

### 1. System Overview
* High-level architectural role of this component/service.
* Relevant bounded contexts (Domain-Driven Design).

### 2. Constraints & Dependencies
* Runtime environments: Node.js, Python, Go, Rust, etc.
* Multi-platform requirements: Windows, macOS, Linux.
* Active external APIs, SDKs, or databases.

### 3. Sourced Assumptions Ledger
Every assumption must be backed by a concrete source:

| ID | Assumption | Source | Status |
|:---|:---|:---|:---|
| A1 | Database schema is PostgreSQL 16+ | `docker-compose.yml:L12` | Verified |
| A2 | Authentication uses JWT bearer tokens | `src/auth/middleware.ts:L45` | Verified |
| A3 | Backward compatibility required for v1 API | User prompt | Inferred |

### 4. Verification Command (`PROOF_CMD`)
The authoritative command that proves functionality without human intervention:
```bash
npm test
# or pytest, cargo test, etc.
```
