---
name: claudegravity-route
description: >-
  Fast triage and routing decision between Anthropic Claude, Google Antigravity (Gemini), or the full Claudegravity Loop.
  Use when deciding which model is best suited for a task, or whether a plan requires full cross-model plan hardening.
---

# Claudegravity Route — Task Triage & Model Selector

Use this skill to determine the most effective execution strategy for a given engineering task.

---

## 1. Triage Decision Matrix

```mermaid
flowchart TD
    Start["New Task / Feature Request"] --> Q1{"Is undoing or fixing a mistake expensive?<br/>(Schema, Auth, Concurrency, Core Architecture)"}
    
    Q1 -->|YES| Loop["🔄 USE CLAUDEGRAVITY LOOP<br/>(Cross-model plan review + build audit)"]
    Q1 -->|NO| Q2{"What type of task is it?"}
    
    Q2 -->|Massive codebase refactor / Deep research / Large multi-file context| AGY["🚀 ROUTE TO ANTIGRAVITY (Gemini)<br/>(Massive 1M+ context, deep code graph reasoning)"]
    Q2 -->|Precision coding / Subtle logic / UI / Complex shell & terminal tasks| Claude["⚡ ROUTE TO CLAUDE CODE<br/>(Tight feedback loops, high-fidelity implementation)"]
    Q2 -->|Trivial copy change / Small typo / Single dependency bump| Solo["🛠️ RUN IN LOCAL HOST<br/>(No cross-model overhead)"]
```

---

## 2. Model Strength Profiles

### Anthropic Claude (Claude 3.7 Sonnet / Opus)
* **Best for**:
  - High-precision algorithms and surgical diffs.
  - Complex agentic command loops and shell interaction.
  - Type-safe refactors with immediate compiler feedback.
  - Frontend, CSS, and UI component construction.

### Google Antigravity (Gemini 2.5 Pro / Flash)
* **Best for**:
  - Huge context windows (up to 1M–2M tokens) analyzing entire codebases at once.
  - Architectural pattern discovery and system dependency graphing.
  - Detecting subtle concurrency bugs, race conditions, and distributed systems deadlocks.
  - Autonomous multi-step research and codebase survey.

---

## 3. When to Escalate to `claudegravity-loop`
Escalate immediately if the task involves:
* Schema migrations with zero downtime.
* Authentication, authorization, or cryptographically sensitive code.
* Asynchronous message queues, locks, or transactional boundaries.
* Public API breaking changes or high-traffic legacy rewrites.
