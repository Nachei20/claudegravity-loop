---
name: antigravity-build
description: >-
  Delegate code implementation to Google Antigravity (Gemini) while Claude independently inspects the resulting diff and validates the test suite.
  Use when you have an approved PLAN.md and want Antigravity to build the patch and Claude to audit it.
---

# Antigravity Build — Delegated Cross-Construction & Audit

A specialized entry point for delegating coding tasks to **Google Antigravity**, while **Anthropic Claude** acts as the cold, independent auditor who verifies the diff and runs the test suite.

---

## When to Use
* You have a frozen, approved `PLAN.md`.
* The task benefits from Antigravity's deep multi-file awareness, autonomous exploration, or massive context window.
* You need Claude to remain completely untainted by the construction process so it can perform an unbiased audit.

---

## The Core Invariant

> **"The builder never audits its own diff."**
> Antigravity writes the code. Claude performs the line-by-line diff inspection and executes the verification command (`PROOF_CMD`).

---

## Execution Protocol

### 1. Preflight
1. Verify working directory is clean: `git status --short`.
2. Confirm `PROOF_CMD` exists and is documented in `PLAN.md`.

### 2. Delegate Construction to Antigravity
Invoke Antigravity with tool execution permissions to implement the spec:
```bash
agy -p "Implement the changes specified in PLAN.md step-by-step. Keep changes strictly bounded to the plan. Do not add unrequested refactors. Run the project tests when finished."
```
Alternatively, if using the `antigravity-plugin-cc` inside Claude Code, run `/antigravity:rescue "Implement PLAN.md"`.

### 3. Independent Diff Inspection (Claude)
Once Antigravity announces completion:
1. Claude inspects the entire diff:
   ```bash
   git diff
   git status --short
   ```
2. Claude compares the diff against `PLAN.md`:
   * Did the implementation introduce scope creep?
   * Are all edge cases and error paths handled as specified?
   * Are type annotations and docstrings preserved?

### 4. Independent Test Proof
Claude independently runs `PROOF_CMD`:
```bash
npm test # or pytest, cargo test, etc.
```
If failures occur, Claude passes the exact failure logs back to Antigravity for a targeted fix round.

### 5. Final Human Approval
Present the diff summary and test proof to the user for final commit sign-off.
