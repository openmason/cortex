# Cortex

## The Shared Agent Runtime

> **Version:** 1.3 · March 2026
> **Status:** Architecture decided. Runics search service in active build (Sprint 3a).
> **Companion docs:** `runics-unified-architecture.md` · `cognium-server-specification.md` · `cognium-client-specification.md` · `forge-specification.md` · `bombastic-specification.md`
> **Scope:** Everything between the products (Bombastic, CoStaff, ControlDeck) and the user. The complete runtime that makes AI agents work.
> **v1.2 changes:** ControlCenter renamed to ControlDeck (controldeck.dev). Cortex API upgraded with AI SDK Data Stream Protocol for AIChatAgent compatibility. Multi-product config shape added. Bombastic thin-wrapper pattern documented.
> **v1.3 changes:** Bombastic agent renamed to Clove. Product defaults resolved server-side by `productId` (products send identity only). Approval timeout added (`approvalTimeoutMs`). Approval signal flow generalized (product-agnostic — no channel dependency). BombasticAgent example updated with error handling and auth headers.

---

## Table of Contents

1. [What Cortex Is](#1-what-cortex-is)
2. [Architecture Overview](#2-architecture-overview)
3. [Design Principles](#3-design-principles)
4. [Component Map](#4-component-map)
5. [Mastra — Orchestration](#5-mastra--orchestration)
6. [Runics — Skill Registry & Search](#6-runics--skill-registry--search)
7. [Forge — Skill Generation & Distillation](#7-forge--skill-generation--distillation)
8. [Cognium — Trust & Security](#8-cognium--trust--security)
9. [Activepieces — Triggers & Events](#9-activepieces--triggers--events)
10. [Daytona — Container Execution](#10-daytona--container-execution)
11. [Skill Execution Layers](#11-skill-execution-layers)
12. [Skill Lifecycle](#12-skill-lifecycle)
13. [Workflow Pause & Human Review](#13-workflow-pause--human-review)
14. [The Request Lifecycle](#14-the-request-lifecycle)
15. [Data Model](#15-data-model)
16. [Multi-Tenancy](#16-multi-tenancy)
17. [Technology Stack](#17-technology-stack)
18. [Deployment Architecture](#18-deployment-architecture)
19. [Cost Model](#19-cost-model)
20. [Build Roadmap](#20-build-roadmap)
21. [Risks & Mitigations](#21-risks--mitigations)
22. [Open Questions](#22-open-questions)

---

## 1. What Cortex Is

Cortex is the shared agent runtime that powers every product on the platform. It sits between what users see (Bombastic, CoStaff, ControlDeck, future products) and the underlying infrastructure (Cloudflare, Neon, Daytona). Products are thin configuration layers on top of Cortex. The intelligence, execution, security, and learning all live here.

```
Products:     Bombastic · CoStaff · ControlDeck · (future SaaS)
                              │
                    ┌─────────┴──────────┐
                    │      CORTEX        │  ← the shared agent runtime
                    │                    │
                    │  Mastra            │  orchestration + memory
                    │  Runics            │  skill registry + search
                    │  Forge             │  skill generation + distillation
                    │  Cognium           │  trust + security scanning
                    │  Activepieces      │  triggers + events
                    │  Daytona           │  container execution
                    └────────────────────┘
                              │
Infrastructure:    Cloudflare · Neon · Workers AI
```

The whole platform boils down to one sentence: **An LLM orchestrator that discovers, evaluates, and executes reusable skills through natural language.**

**ControlDeck** (controldeck.dev) is the B2B and partner-facing product built on Cortex. It exposes the full platform capability — workflow authoring, skill composition, human review gates, and the save-as-skill loop — to business operators and integration partners. Where Bombastic is personal and CoStaff is departmental, ControlDeck is the autonomous improvement infrastructure layer.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              PRODUCTS                                    │
│                                                                          │
│   ┌────────────┐  ┌────────────┐  ┌─────────────────────────────┐       │
│   │ Bombastic  │  │  CoStaff   │  │      ControlDeck            │       │
│   │ Personal   │  │ Business   │  │ B2B / Partner Platform      │       │
│   │ assistant  │  │ automation │  │ Workflow authoring +        │       │
│   │            │  │ + policies │  │ Skill composition +         │       │
│   │            │  │            │  │ Human review gates          │       │
│   └─────┬──────┘  └─────┬──────┘  └─────────────┬───────────────┘       │
│         └───────────────┴─────────────────────────┘                     │
│                              │                                           │
│  ════════════════════════════╪══════════════════════════════════════      │
│                              │   CORTEX                                  │
│                              ▼                                           │
│   ┌──────────────────────────────────────────────────────────────────┐  │
│   │  MASTRA (Orchestration)                                          │  │
│   │  Supervisor agent · Memory · Durable execution · Streaming       │  │
│   │  Pause/Resume for human review gates                             │  │
│   └──────────────────────────┬───────────────────────────────────────┘  │
│                              │                                           │
│   ┌──────────────────────────▼───────────────────────────────────────┐  │
│   │  RUNICS (Skill Registry)                                         │  │
│   │  Semantic search · Trust filtering · Version lineage             │  │
│   │  Status-aware (published/vulnerable/revoked/degraded)            │  │
│   └──┬──────────────────────────────────────────────┬───────────────┘  │
│      │                                              │                   │
│   ┌──▼──────────────┐           ┌───────────────────▼────────────────┐  │
│   │ COGNIUM (Trust) │           │ EXECUTION ROUTER                   │  │
│   │ Severity-based  │           │ L0: MCP · L1: Instruct             │  │
│   │ revocation      │           │ L2: Worker · L3: Daytona           │  │
│   │ Composite        │           └───────────────────┬────────────────┘  │
│   │ degradation     │                               │                   │
│   └─────────────────┘           ┌───────────────────▼────────────────┐  │
│                                 │ FORGE (Skill Learning)             │  │
│   ┌─────────────────┐           │ Auto-distill · Human-distill       │  │
│   │  ACTIVEPIECES   │           │ Generate-before · Save-as-skill    │  │
│   │  Triggers/Events│           └────────────────────────────────────┘  │
│   └─────────────────┘                                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Design Principles

**Skills are functions, not services.** A skill is code with an MCP interface. It boots, executes, returns, and dies. Nothing needs to be always alive except triggers and the database.

**The LLM is the only decision-maker.** Mastra's supervisor agent plans, dispatches, reads results, and loops. Execution layers are invisible to it. Whether a skill runs as a remote HTTP call, a Cloudflare Worker, or a container — the LLM doesn't know or care.

**Skills are immutable, trust is versioned.** A published skill cannot be modified. To change it, fork it. Trust scores are earned per version, not inherited. This makes every workflow reproducible and every security guarantee auditable.

**Single-system simplicity.** All persistent state lives in one Postgres database. No sync queues, no eventual consistency, no second system to monitor.

**Measure first.** Validate performance through evaluation suites before adding architectural complexity.

**Integration over invention.** Leverage existing open-source TypeScript solutions (Mastra, Activepieces, Daytona, Drizzle, Hono) over custom development. Build only the parts that don't exist: confidence-gated search, skill distillation, trust scoring.

**Layered execution minimizes cost.** Route 65% of skill executions to zero-cost paths (remote MCP, LLM instructions), 20% to near-zero-cost Workers, and only 15% to containers.

**Human in the loop is a first-class feature.** Workflows can pause before execution for human plan review, modification, and approval. This is especially important for ControlDeck's B2B and partner use cases.

---

## 4. Component Map

| Component | Role | Build vs Buy | Always On? |
|---|---|---|---|
| **Mastra** | Orchestration, memory, durable execution, pause/resume | Buy (OSS) | Workers (serverless) |
| **Runics** | Skill registry, semantic search, status filtering | Build | Workers (serverless) |
| **Forge** | Skill generation, auto-distillation, human-distillation | Build | Queue consumer |
| **Cognium** | Trust scoring, severity-based revocation | Build | Queue consumer |
| **Activepieces** | Event triggers, webhooks, cron | Buy (OSS, self-hosted) | Always on |
| **Daytona** | Container sandboxes for Layer 3 skill execution | Buy (AGPL, cloud) | On-demand |

---

## 5. Mastra — Orchestration

### What It Does

Mastra is the supervisor brain. Every user request becomes a Mastra agent session. The supervisor agent plans, calls Runics to find skills, routes execution, reads results, and loops until the task is done.

### Pause / Resume for Human Review

Mastra's durable execution (Cloudflare Durable Objects) supports pause/resume natively. Cortex uses this for human review gates — critical for ControlDeck workflows where operators want to approve plans before execution.

```typescript
// Step 1: supervisor plans the workflow
const planStep = new Step({
  execute: async ({ context }) => {
    const plan = await supervisor.plan(context.input);

    // Pause and surface the plan for human review
    await workflow.pause({
      resumeData: plan,
      timeoutMs: 300_000,  // 5 minutes
    });

    return plan;  // reached only after resume
  }
});

// Step 2: execution uses the (possibly modified) plan
const executeStep = new Step({
  execute: async ({ context }) => {
    const approvedPlan = context.resumeData;  // may have been edited by user
    return await executePlan(approvedPlan);
  }
});
```

### Three Execution Modes

| Mode | Behaviour | Default For |
|---|---|---|
| **Full auto** | Plans and executes without stopping | Recurring / trusted workflows |
| **Review before run** | Pauses after planning, resumes after approval | ControlDeck default |
| **Step-by-step** | Pauses after every step for human confirmation | High-stakes workflows |

The mode is a policy — configurable per tenant, per workflow, or per skill category. CoStaff's policy engine can enforce review-before-run for any skill category marked as sensitive.

### Product Agents

```typescript
// Bombastic — personal assistant (Clove agent)
const bombastic = new Agent({
  tools: [findSkillTool, invokeSkillTool, ...mastraBuiltins],
  memory: mastraMemory,
  instructions: "You are Clove, a personal AI agent. Use findSkill to discover capabilities...",
});

// CoStaff — business automation with policies
const costaff = new Agent({
  tools: [findSkillTool, invokeSkillTool, checkPolicyTool, ...mastraBuiltins],
  memory: mastraMemory,
  instructions: "You are a business automation agent. Check policies before executing skills.",
});

// ControlDeck — B2B / partner with human review gates
const controldeck = new Agent({
  tools: [findSkillTool, invokeSkillTool, checkPolicyTool, pauseForReviewTool, ...mastraBuiltins],
  memory: mastraMemory,
  instructions: "You are a business process automation platform. Plan workflows, present them for human approval, then execute.",
});
```

The only differences between products: system instructions, trust appetite threshold, whether a policy engine is in the loop, and whether human review gates are enabled by default.

---

## 6. Runics — Skill Registry & Search

Runics is the nervous system. It indexes skills, generates search-optimized embeddings, and serves semantic search with sub-50ms latency.

Key properties:

- Skills are filtered by `status` — `revoked` skills are excluded from search entirely. `vulnerable` skills surface with a warning badge.
- Search returns version-aware results — the best version per skill slug is surfaced by default (trust × usage signal, not newest).
- Composite skills inherit status from sub-skills — a composite becomes `contains-vulnerable` if any constituent is `vulnerable`, or `degraded` if any constituent is `revoked`.

See `runics-unified-architecture.md` for full detail.

---

## 7. Forge — Skill Generation & Distillation

Forge is the learning loop. Three modes:

- **Mode 1 (Generate-before):** LLM generates a new skill on the fly when no match is found.
- **Mode 2 (Auto-distill):** Post-workflow hook evaluates traces for reusable patterns and distills them automatically.
- **Mode 3 (Human-distill):** User explicitly saves a modified workflow as a named skill via the Save-as-Skill UX.

Human-distilled skills get a trust premium over auto-distilled skills at the same score, displayed as a **Human-verified** badge in the UI. All distilled skills are immutable — forks are required to modify.

See `forge-specification.md` for full detail.

---

## 8. Cognium — Trust & Security

Cognium pre-computes trust scores for all skills and enforces severity-based status transitions:

| Severity | Action | Effect |
|---|---|---|
| CRITICAL | Hard revoke | Pulled from search index, new invocations blocked |
| HIGH | Flag + notify | Stays in search with warning badge, runtime warning injected |
| MEDIUM | Flag only | Advisory badge in UI, no execution impact |
| LOW | Advisory | Surfaced in skill detail, no action |

Revoked skills trigger a cascade: all composite skills containing them are marked `degraded`. Vulnerable skills cascade to `contains-vulnerable` on composites. Partner-facing error messages always include the specific CVE and the path forward (fork suggestion or available patched version).

See `cognium-specification.md`, `cognium-server-specification.md`, and `cognium-client-specification.md` for full detail.

---

## 9. Activepieces — Triggers & Events

Activepieces is the event layer. It listens for external events (webhooks, cron, email, Stripe payments, GitHub PRs) and fires Mastra workflows in response.

**Example triggers for ControlDeck:**

| Trigger | Workflow |
|---|---|
| GitHub PR opened | Clone → Cognium scan → post results as PR comment |
| Every Monday 9am | Fetch sales data → generate report → post to Slack |
| Stripe payment succeeds | Generate invoice → email customer |
| Slack message mentions bot | Parse request → find skill → execute → reply in thread |

---

## 10. Daytona — Container Execution

Daytona provides on-demand container sandboxes for Layer 3 skill execution. Cognium scanning uses Circle-IR (circle.phantoms.workers.dev), not Daytona containers.

| Dimension | Daytona | E2B |
|---|---|---|
| Boot time | ~90ms | ~150ms |
| Session duration | Unlimited | 1hr–24hr |
| Self-host | Yes (AGPL-3.0) | Yes (Apache-2.0) |
| Per-sandbox cost | ~$0.067/hr | ~$0.05/hr |

---

## 11. Skill Execution Layers

The execution router maps `skill.execution_layer` to the right runtime:

| Layer | Mechanism | Boot | Cost/Exec | ~% of Skills | Example |
|---|---|---|---|---|---|
| **L0** Remote MCP | HTTP call to external server | 0ms | $0 | ~30% | GitHub API, Slack, Amadeus |
| **L1** Instructions | LLM reads SKILL.md, uses Mastra tools | 0ms | $0 infra | ~35% | Shell commands, simple ops |
| **L2** Worker | Pure function on Cloudflare | <5ms | ~$0.00001 | ~20% | JSON transforms, license checks |
| **L3** Container | Daytona sandbox, boot→run→destroy | ~90ms | ~$0.001–0.10 | ~15% | cargo tools, Playwright, binaries |

65% of executions hit L0/L1 (zero infra cost). 5× cost reduction over running everything in containers.

**Routing decision tree:**
```
Is the skill a remote MCP server?
├─ YES → L0
└─ NO → Needs filesystem, binaries, or browser?
         ├─ YES → L3 (Daytona)
         └─ NO → Pure JS/TS, no heavy deps?
                  ├─ YES → L2 (Worker)
                  └─ NO → Just instructions?
                           ├─ YES → L1
                           └─ NO → L2
```

---

## 12. Skill Lifecycle

### Skill Types

Every skill in the registry has a type reflecting how it was created:

| Type | Description | Trust Origin |
|---|---|---|
| **Atomic** | Single tool, single execution layer | Cognium scan of source |
| **Auto-Composite** | Forge-distilled from agent trace | Starts at 0.3, Cognium rebuilds |
| **Human-Composite** | User saved a modified workflow | Trust floor, earns via runs |
| **Forked** | Copy of any skill + modifications | Trust resets, provenance preserved |

### Skill Source

| Source | Description |
|---|---|
| `mcp-registry` | Synced from Anthropic's MCP registry |
| `clawhub` | Synced from ClawHub |
| `github` | Discovered via skills.sh / SKILL.md convention |
| `forge` | Auto-distilled by Forge from execution traces |
| `human-distilled` | Explicitly saved by a user post-run |
| `manual` | Directly published via API |

### Trust Levels

| Score | Label | Behaviour |
|---|---|---|
| 0.85+ | High trust | Executes without friction |
| 0.50–0.84 | Balanced | Default appetite, runs normally |
| 0.30–0.49 | Low trust | Runs with runtime warning surfaced |
| <0.30 | Untrusted | Blocked unless tenant explicitly overrides |

Trust is per-version. A fork starts at the floor regardless of parent score.

### Status State Machine

```
draft → published → deprecated        (owner-initiated, soft)
             │        ↑
             ├──→ vulnerable ──────────┘ (Cognium: clean re-scan restores)
             │         │
             │         └──→ revoked    (Cognium: CRITICAL severity escalation)
             │
             └──→ revoked              (Cognium: CRITICAL severity, direct)
```

Composite skills carry two distinct **derived statuses** (Cognium-controlled):

```
contains-vulnerable  (derived: ≥1 constituent is 'vulnerable')
degraded             (derived: ≥1 constituent is 'revoked')
```

Both repair automatically when the constituent's status is restored (clean re-scan → `published`).

`deprecated` is owner-controlled. `vulnerable`, `contains-vulnerable`, `degraded`, and `revoked` are Cognium-controlled. These are separate axes — an owner can deprecate a clean skill; Cognium can revoke a skill the owner never intended to deprecate.

### Severity → Action Policy

| Cognium Severity | Status Transition | Search Behaviour | Execution |
|---|---|---|---|
| CRITICAL | → `revoked` | Removed from index immediately | Blocked — new invocations error |
| HIGH | → `vulnerable` | Stays in search, warning badge | Allowed — runtime warning injected |
| MEDIUM | → `vulnerable` | Advisory badge | Allowed — no execution impact |
| LOW | Advisory only | No status change | Allowed — detail page note |

**Composite cascade:** When a constituent skill is revoked, all composites containing it are immediately marked `degraded`. When a constituent is `vulnerable`, composites are marked `contains-vulnerable`.

**In-flight protection:** A hard revoke (CRITICAL) allows currently running invocations to finish. New invocations after the revoke are blocked.

**Remediation messaging:** Revoked skill errors always include the specific CVE and the path forward:

```
❌ Workflow blocked

cargo-audit@1.0.0 was revoked due to CRITICAL vulnerability
RUSTSEC-2024-XXXX (arbitrary code execution via malformed YAML).

Your options:
  → Fork timon-security-review@1.0.0 and swap in cargo-audit@1.2.0
  → Pin to timon-security-review@1.1.0 (already uses patched version)
  → Contact your admin to approve an exception
```

### Immutability + Fork Model

Published skills are immutable. To modify:

```
timon-security-review@1.0.0   [immutable, trust: 0.81, runs: 47]
    │
    ├─ edit attempted
    │       ↓
    │   "Skills are immutable. Fork to create a new version?"
    │       ↓
    │   [ Fork & Edit ]
    │
    └─ timon-security-review@1.1.0   [new, trust: floor*, runs: 0]
            *trust resets — new skill, unproven
```

**Version lineage in search:**
```
timon-security-review
  ├── @1.0.0  trust: 0.81  runs: 47  ← default (highest trust × usage)
  ├── @1.1.0  trust: 0.71  runs: 12
  └── @2.0.0  trust: 0.63  runs: 2
```

Runics surfaces the best version by default (trust × run count), not the newest. Users can pin to a specific version explicitly.

**Fork provenance:**
```typescript
{
  slug: "timon-security-review",
  version: "1.1.0",
  forked_from: "timon-security-review@1.0.0",
  forked_by: "user:eyal",
  changes: ["added cargo-deny", "removed cargo-clippy"],
  source: "human-distilled",
  trust_score: 0.63,   // reset
  runs: 0
}
```

---

## 13. Workflow Pause & Human Review

### Save-as-Skill UX (ControlDeck / CoStaff)

After a successful run, the platform surfaces a save prompt:

```
✅ Workflow completed in 48s

┌─────────────────────────────────────────────┐
│  Save this as a reusable skill?             │
│                                             │
│  Name:  [ Timon Security Review         ]   │
│  Slug:  timon-security-review  (auto)       │
│                                             │
│  Description:                               │
│  [ Full Rust repo review: lint, vuln scan, ]│
│  [ license check, tests, secret detection  ]│
│                                             │
│  Visibility:  ● Private  ○ Team  ○ Public   │
│                                             │
│  Steps included:                            │
│  ✓ cargo-git-clone                          │
│  ✓ cargo-clippy                             │
│  ✓ cargo-audit                              │
│  ✓ vault-secret-scanner  (your custom)      │
│  ✗ cargo-test  (removed by you)             │
│                                             │
│  [ Save Skill ]  [ Not now ]               │
└─────────────────────────────────────────────┘
```

On save, Forge's human-distill endpoint is called. It:
1. Generates alt-queries from the user's description (for Runics embedding)
2. Computes composite trust: `min(sub-skills) × composition_discount`
3. Publishes to Runics within seconds
4. Marks the skill with `source: 'human-distilled'` and a **Human-verified** badge

### Trust Provenance Badges

```
[⚡ Composite]  timon-security-review
Built from 4 skills  •  Human-verified  •  trust: 0.81
Last run: 2 hours ago  •  Used 3 times this week

[🤖 Auto-distilled]  rust-review-pipeline
Built from 4 skills  •  Agent-generated  •  trust: 0.63
```

Human-distilled skills get a trust premium signal in ranking. Agents can see both badges and factor them into skill selection reasoning.

### The Flywheel

```
Week 1: Partner A saves "Timon Security Review"
Week 2: Partner B runs "check rust codebase" → composite surfaces → runs it
Week 2: Partner B modifies (adds cargo-deny), saves "Full Rust Compliance Review"
Week 3: Both composites in registry, covering different intents
Week 4: Forge sees both used frequently → suggests merging into parameterized skill
```

---

## 14. The Request Lifecycle

### Example: "Review this GitHub Rust repo: github.com/org/timon"

```
1. USER PROMPT (ControlDeck)
   "Review this GitHub Rust repo: github.com/org/timon"
       │
       ▼
2. MASTRA SUPERVISOR (plan phase)
   Goal: comprehensive Rust repo review
   Planning: clone → lint → audit → licenses → tests → scan → summarize
       │
       ▼
3. RUNICS QUERIES (skill discovery)
   findSkill("clone a git repository")          → cargo-git-clone     trust: 0.94
   findSkill("rust linting code quality")       → cargo-clippy        trust: 0.91
   findSkill("rust dependency vulnerabilities") → cargo-audit         trust: 0.89
   findSkill("rust license compliance")         → cargo-deny          trust: 0.92
   findSkill("run rust test suite")             → cargo-test          trust: 0.88
   findSkill("static security analysis")        → semgrep-rust        trust: 0.85
       │
       ▼
4. PAUSE FOR REVIEW (ControlDeck mode)
   Plan presented to user — add/remove/reorder steps
   User removes cargo-test, adds vault-secret-scanner
   User clicks "Run"
       │
       ▼
5. EXECUTION (single Daytona sandbox)
   git clone github.com/org/timon         [2.1s]
   cargo clippy                           [8.3s]  → 3 warnings, 1 error
   cargo audit                            [4.2s]  → 2 CVEs found
   cargo deny check licenses              [3.1s]  → 1 GPL conflict
   vault-secret-scanner                   [5.8s]  → 1 hardcoded secret
   semgrep-rust                           [6.4s]  → 1 hardcoded secret
   Sandbox destroyed
       │
       ▼
6. LLM SUMMARY
   CRITICAL: RUSTSEC-2024-XXXX in serde_yaml, hardcoded API key in src/config.rs:42
   HIGH: openssl GPL-3.0 license conflict
   WARNINGS: 3 clippy warnings
   Recommend: block merge until CRITICAL items resolved
       │
       ▼
7. SAVE PROMPT
   "Save this as a reusable skill?" → User saves as "Timon Security Review"
       │
       ▼
8. POST-WORKFLOW (async)
   Forge: human-distill endpoint called
   Cognium: composite trust computed (0.81)
   Runics: indexed, searchable within seconds
   All future "review rust repo" queries surface this composite first
```

**Total wall time: ~50 seconds.** The demo shows a single natural-language prompt producing a multi-tool security review, with the user in control of the plan, the result, and the reusable skill it becomes.

---

## 15. Data Model

### Core `skills` table additions (v1.1 → v5.0)

```sql
-- Skill lifecycle status
status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft', 'published', 'deprecated', 'vulnerable', 'revoked', 'degraded', 'contains-vulnerable')),
revoked_at TIMESTAMPTZ,
revoked_reason TEXT,                      -- CVE ID or description
deprecated_at TIMESTAMPTZ,
deprecated_reason TEXT,
remediation_message TEXT,                 -- human-readable path forward (from Cognium)
remediation_url TEXT,                     -- link to advisory

-- Skill type and composition
skill_type TEXT NOT NULL DEFAULT 'atomic'
  CHECK (skill_type IN ('atomic', 'auto-composite', 'human-composite', 'forked')),
composition_skill_ids UUID[],             -- denorm array for fast cascade queries

-- Version lineage
version TEXT NOT NULL DEFAULT '1.0.0',
forked_from TEXT,                         -- 'slug@version' of parent
forked_by TEXT,                           -- user ID or 'forge'
fork_changes JSONB,                       -- list of changes from parent
root_source TEXT,                         -- original registry source (preserved across forks)

-- Human distillation
human_distilled_by TEXT,                  -- user ID
human_distilled_at TIMESTAMPTZ,

-- Cognium attestation fields (latest)
cognium_findings JSONB,                   -- [{severity, cwe_id, tool, title, description, confidence, verdict}]
analyzer_summary JSONB,                   -- per-analyzer breakdown
verification_tier TEXT DEFAULT 'unverified'
  CHECK (verification_tier IN ('unverified', 'scanned', 'verified', 'certified')),
scan_coverage TEXT
  CHECK (scan_coverage IN ('full', 'partial', 'text-only')),

-- Trust provenance badge
trust_badge TEXT CHECK (trust_badge IN ('human-verified', 'auto-distilled', 'upstream', null)),

-- Run signal for version ranking
run_count INTEGER NOT NULL DEFAULT 0,
last_run_at TIMESTAMPTZ,
```

### Version ranking query

Runics surfaces the best version per slug using trust × run signal:

```sql
SELECT DISTINCT ON (slug)
  id, slug, version, trust_score, run_count, status
FROM skills
WHERE slug = :slug
  AND status NOT IN ('revoked', 'draft')
  AND (tenant_id IS NULL OR tenant_id = :tenantId)
ORDER BY slug, (trust_score * 0.7 + LEAST(run_count::float / 100, 0.3)) DESC;
```

---

## 16. Multi-Tenancy

Skills have three visibility levels:

| Visibility | `tenant_id` | Searchable by |
|---|---|---|
| Public | NULL | All tenants |
| Team | tenant_id set | Only that tenant |
| Private | tenant_id + user_id | Only that user |

Human-distilled composites default to Team visibility. Users explicitly upgrade to Public.

---

## 17. Technology Stack

| Component | Technology |
|---|---|
| Agent orchestration | Mastra (TypeScript, Cloudflare Workers) |
| Skill registry | Hono + pgvector (Cloudflare Workers + Neon) |
| Embeddings | bge-small-en-v1.5 (Workers AI) |
| Trust scoring | Cognium Client (Cloudflare Workers) + Circle-IR (SAST, external) |
| Skill distillation | Forge (Cloudflare Queue consumer) |
| Triggers | Activepieces (self-hosted) |
| Container execution | Daytona (cloud) |
| Database | Neon Postgres |
| Object storage | Cloudflare R2 |
| Cache | Cloudflare KV |
| LLM | Claude Sonnet (Anthropic API) |

---

## 18. Deployment Architecture

All Cortex components deploy to Cloudflare Workers (serverless, global edge). Neon Postgres is accessed via Hyperdrive for pooled connections. Daytona is called on-demand from Workers. Activepieces runs on a single $10/month VPS.

Nothing is always-on except Activepieces (trigger listener), Postgres, and the Workers runtime itself.

---

## 19. Cost Model

| Component | Monthly (100 active users) |
|---|---|
| Cloudflare Workers (all services) | ~$5–10 |
| Neon Postgres | ~$19 (Pro plan) |
| Daytona (execution containers) | ~$30–80 |
| Cognium scanning containers | ~$3–5 |
| Workers AI (embeddings + safety) | ~$2–5 |
| Anthropic API (Claude Sonnet) | ~$50–150 |
| Activepieces VPS | ~$10 |
| **Total** | **~$120–280/month** |

Execution layer routing (65% L0/L1, 20% L2, 15% L3) is the primary cost lever. Moving a skill from L3 to L2 cuts its per-execution cost by ~10,000×.

---

## 20. Build Roadmap

| Sprint | Focus | Key Deliverables |
|---|---|---|
| Sprint 3a (now) | Runics search | Eval suite hardening, threshold calibration, Phase 2 complete |
| Sprint 4 | Cognium + Forge | Trust scoring, auto-distillation, human-distill endpoint |
| Sprint 5 | Cortex runtime | Execution router, Mastra integration, pause/resume |
| Sprint 6 | ControlDeck | Save-as-skill UX, partner API, composite management |
| Sprint 7 | Scale & Polish | Versioning UI, revocation cascade, remediation messages |

---

## 21. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Runics returns wrong skills in demo | Pre-index the 6 rust review skills with optimized descriptions and alt-queries before any demo |
| Trust score gaming | Cognium is probabilistic, not proof-of-safety. Daytona sandbox isolation is the last line of defense |
| Composite degradation false alarms | Only CRITICAL triggers hard revoke + `degraded` cascade. HIGH/MEDIUM sets constituent `vulnerable` + composite `contains-vulnerable`. Different UX treatment — `contains-vulnerable` shows warning badge, `degraded` blocks. |
| Human-distilled quality | User description drives alt-query embedding quality — bad description → poor discoverability |

---

## 22. Open Questions

**Progressive scan:** Should Cognium run a fast partial scan (content safety + basic, ~5s) before the full scan (~60s) to give skills a preliminary trust score faster?

**Composite merge suggestion:** Should Forge suggest merging two similar human-distilled composites into a single parameterized skill when usage patterns converge?

**Manual trust override:** Should workspace admins be able to override Cognium trust scores? Necessary for enterprise (internal tools that fail open-source license checks).

---

## 23. Cortex API — Multi-Product Interface

Every product connects to Cortex through a single unified API. The product passes a config object at session creation — Cortex reads it and applies it to all downstream components automatically. This is what makes Cortex a platform, not just internal infrastructure.

### Session Config Shape

```typescript
interface CortexSessionConfig {
  // Identity
  productId: 'bombastic' | 'costaff' | 'controldeck' | string; // string for external SaaS
  tenantId: string | null;   // null = personal (Bombastic)
  userId: string;

  // System prompt — defines product personality
  systemPrompt: string;

  // Trust appetite — passed directly to Runics search
  appetite: 'strict' | 'cautious' | 'balanced' | 'adventurous';
  minTrust: number;          // 0.0–1.0
  allowVulnerable: boolean;

  // Approval behaviour
  approvalMode: 'never' | 'side-effects-only' | 'policy-defined' | 'always';

  // Feature flags
  policyEngine: boolean;     // CoStaff, ControlDeck only
  humanReviewGates: boolean; // ControlDeck only

  // Approval timeout — auto-cancel workflow if no response
  approvalTimeoutMs?: number; // default: none (ControlDeck). Bombastic: 1_800_000 (30 min)
}
```

### Product Defaults

```typescript
// Bombastic — personal assistant (Clove agent)
// Product defaults resolved server-side — Bombastic sends only productId + userId + messages
const bombasticConfig: CortexSessionConfig = {
  productId: 'bombastic',
  tenantId: null,
  systemPrompt: "You are Clove, a personal AI agent on the Bombastic platform. Discover capabilities dynamically using findSkill. Only load the skills needed for the current request. When a skill has side effects, always request approval before executing. If a skill is unverified, warn the user before proceeding. Be direct and concise.",
  appetite: 'balanced',
  minTrust: 0.50,
  allowVulnerable: true,
  approvalMode: 'side-effects-only',
  policyEngine: false,
  humanReviewGates: false,
  approvalTimeoutMs: 1_800_000,    // 30 min — auto-cancel if no response
};

// CoStaff — business automation
const costaffConfig: CortexSessionConfig = {
  productId: 'costaff',
  tenantId: 'company-abc',   // set per tenant
  systemPrompt: "You are a business automation agent. Check policies before executing skills. Prefer cautious actions.",
  appetite: 'cautious',
  minTrust: 0.70,
  allowVulnerable: false,
  approvalMode: 'policy-defined',
  policyEngine: true,
  humanReviewGates: false,
};

// ControlDeck — B2B / partner platform
const controldeckConfig: CortexSessionConfig = {
  productId: 'controldeck',
  tenantId: 'partner-xyz',   // set per partner tenant
  systemPrompt: "You are a business process automation platform. Plan workflows, present them for human approval, then execute.",
  appetite: 'cautious',
  minTrust: 0.70,
  allowVulnerable: false,
  approvalMode: 'always',
  policyEngine: true,
  humanReviewGates: true,
};
```

### What Each Config Field Controls

| Field | Affects |
|---|---|
| `systemPrompt` | Mastra agent instructions |
| `appetite` + `minTrust` + `allowVulnerable` | Runics search filter |
| `approvalMode` | Whether Mastra pauses before side-effect skills |
| `approvalTimeoutMs` | Auto-cancel paused workflow after this duration (optional) |
| `policyEngine` | Whether CoStaff policy check runs pre-execution |
| `humanReviewGates` | Whether plan is surfaced for review before execution |
| `tenantId` | Runics skill visibility scope |

**Server-side resolution:** Products send only `productId`, `userId`, and `messages`. Cortex looks up the full config by `productId`. This keeps products thin and prevents config drift across deployments.

---

## 24. Cortex API — AI SDK Data Stream Protocol

Cortex's `/v1/chat` endpoint emits responses in the **AI SDK Data Stream Protocol** format. This enables AIChatAgent compatibility for all products without any product owning the LLM call directly.

### Why This Matters

Any product that wraps `AIChatAgent` (Bombastic, CoStaff, ControlDeck, or an external SaaS customer) gets streaming, message persistence, reconnection, and the `useAgentChat` React hook for free — because Cortex speaks the protocol those tools expect.

### Stream Format

Cortex emits newline-delimited chunks in the AI SDK data stream format:

```
// Text chunk
0:"Hello, I found "

// Tool call start (Runics query)
9:{"toolCallId":"tc-1","toolName":"find-skill","args":{"query":"send email"}}

// Tool result (skill found)
a:{"toolCallId":"tc-1","result":{"slug":"email-send","trustScore":0.91,"status":"published"}}

// Approval required — data part (reconcilable by id)
2:[{"type":"approval-required","id":"appr-abc","toolCallId":"tc-1",
    "skillName":"email-send","trustScore":0.91,
    "payload":{"to":"john@co.com","subject":"Thursday Brief"}}]

// Text continuation
0:"I've paused to get your approval before sending."

// Finish
e:{"finishReason":"tool-calls"}
d:{"finishReason":"tool-calls"}
```

### Approval Signal Flow

When Mastra pauses a workflow (side-effect skill, policy gate, or human review gate), Cortex emits an `approval-required` data part before closing the stream. The product's `AIChatAgent` wrapper receives this and persists it to its Durable Object SQLite. How the approval is presented to the user is product-owned — Bombastic renders inline buttons in its SPA; ControlDeck shows a review panel; future products may use WhatsApp, push notifications, or other channels.

```
Mastra pauses workflow
        │
        ▼
Cortex emits 2:[{type:"approval-required", id:"appr-abc", ...}]
        │
        ▼
AIChatAgent DO persists to SQLite (survives refresh/hibernation)
        │
        ▼
Product renders approval UI (product-owned)
  ├── Bombastic: inline buttons in SPA at clove.run
  ├── ControlDeck: review panel with plan editor
  └── Future: WhatsApp buttons, push notifications, etc.
        │
  User approves or rejects (or timeout fires)
        │
  POST /approvals/appr-abc/approve (or /reject)
        │
  Cortex → Mastra.resume(workflowId) or Mastra.cancel(workflowId)
        │
  Stream resumes → completion (or cancellation message)
```

If `approvalTimeoutMs` is set in the product config, Cortex auto-cancels the paused workflow after that duration and emits a timeout data part.

### Cortex Endpoint Summary

```
POST /v1/chat                    Start or continue a session, returns data stream
POST /v1/approvals/:id/approve   Resume a paused workflow
POST /v1/approvals/:id/reject    Cancel a paused workflow
GET  /v1/sessions/:id/state      Current session state (for reconnect)
GET  /health                     Service health
```

---

## 25. Product Wrapper Pattern (Bombastic Example)

Each product is a thin `AIChatAgent` subclass. It does not own the LLM call — it proxies to Cortex and pipes the data stream back. Products send only identity fields; Cortex resolves the full config server-side.

```typescript
// bombastic/src/agent.ts

export class BombasticAgent extends AIChatAgent<Env> {

  // 1. Proxy to Cortex, pipe AI SDK data stream back
  async onChatMessage(onFinish) {
    return createDataStreamResponse({
      execute: async (dataStream) => {
        try {
          const res = await fetch(`${this.env.CORTEX_URL}/v1/chat`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.env.CORTEX_API_KEY}`,
            },
            body: JSON.stringify({
              productId: 'bombastic',
              userId: this.name,           // DO instance name = session ID
              messages: this.messages,
            }),
          });

          if (!res.ok) {
            dataStream.writeData([{
              type: 'error',
              message: 'Something went wrong. Please try again.',
            }]);
            return;
          }

          // Pipe Cortex data stream → AIChatAgent data stream
          await pipeDataStream(res.body, dataStream);
        } catch (err) {
          dataStream.writeData([{
            type: 'error',
            message: 'Could not reach Clove\'s brain. Please try again in a moment.',
          }]);
        }
      },
      onFinish,
    });
  }

  // 2. Resume endpoint — called by SPA inline approval buttons
  //    (v1.1: also called by WhatsApp webhook via Activepieces)
  @callable()
  async resolveApproval(approvalId: string, decision: 'approve' | 'reject') {
    await fetch(`${this.env.CORTEX_URL}/v1/approvals/${approvalId}/${decision}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.env.CORTEX_API_KEY}` },
    });
    await this.setState({ pendingApproval: null });
  }
}
```

**What this pattern gives every product:**
- WebSocket management — free via AIChatAgent
- Message persistence (SQLite in DO) — free via AIChatAgent
- Stream reconnection across page refresh — free via AIChatAgent
- `useAgentChat` React hook for web UI — free
- Mobile v2 WebSocket client connects to same DO — no backend change needed
- Approval state survives DO hibernation — free via needsApproval persistence

**What Cortex owns:** Mastra orchestration, Runics search, Cognium trust, Forge distillation, skill execution, product config resolution.

**What the product owns:** UI, approval presentation (inline buttons, WhatsApp, push, etc.), and the `@callable` resume endpoint.

New products — including external SaaS customers using Cortex as a platform — follow the same pattern. Different `productId`, different UI, same runtime.

---

*Cortex is the runtime. Clove is the agent. ControlDeck is the platform. Skills are the currency. — Cognium Labs*
