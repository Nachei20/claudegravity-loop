---
name: antigravity-review
description: >-
  Have Google Antigravity (Gemini) independently review an existing implementation plan while Claude coordinates a bounded revision loop.
  Use when you ALREADY have a plan or architectural proposal in PLAN.md and want an adversarial cross-model stress-test without a full interview.
---

# Antigravity Review — Standalone Adversarial Plan Review

A specialized entry point to submit an existing plan to **Google Antigravity (Gemini)** for an aggressive, hostile, read-only code and architecture review.

---

## When to Use
* You already wrote or generated `PLAN.md` (or a specification document).
* You want an independent, different foundation model to find vulnerabilities, concurrency pitfalls, and hidden edge cases before implementation.
* You do **not** need a requirements interview first.

---

## Execution Protocol

### 1. Preflight Verification
Confirm Google Antigravity CLI (`agy`) is reachable:
* Windows: `%LOCALAPPDATA%\agy\bin\agy.exe` or `where agy`
* Unix: `~/.local/bin/agy` or `which agy`

### 2. Prepare the Frozen Plan
Ensure the plan is written in `PLAN.md`. Initialize `PLAN-REVIEW-LOG.md` if not already present.

### 3. Send to Antigravity (Headless Read-Only Mode)
Execute:
```bash
agy -p "You are an adversarial reviewer for an implementation plan. Your job is to find flaws, not to validate or flatter. Read the frozen plan below. Identify concrete flaws: security vulnerabilities, race conditions, edge cases, schema conflicts, or hidden assumptions. For each flaw, provide a specific technical fix. End your response with EXACTLY one of: VERDICT: APPROVED or VERDICT: REVISE.

=== PLAN.md ===
$(cat PLAN.md)
" --mode plan
```

> [!IMPORTANT]
> The plan must be **inlined into the prompt**. In headless mode, tool permission prompts are auto-denied, so directing `agy` to read from the filesystem without inlining will yield empty results.

### 4. Arbitrate Findings
1. For every finding returned by Antigravity:
   * **If Accepted**: Update `PLAN.md` with the fix and log as `[ACCEPTED]` in `PLAN-REVIEW-LOG.md`.
   * **If Rejected**: State the technical refutation in `PLAN-REVIEW-LOG.md` as `[REJECTED]` (never dismiss as 'out of scope' without technical rationale).
2. For subsequent rounds, resume the conversation with `-c` or `--conversation <ID>` so Antigravity retains conversational context.
3. Repeat until `VERDICT: APPROVED` or **MAX_ROUNDS (default 5)**.
4. Obtain human sign-off before writing any code.
