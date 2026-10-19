# Architecture

```
┌────────────── Browser (React, web/) ──────────────┐
│ Dashboard · Attention queue · Project detail ·    │
│ New project · Settings   (polls /api every 2s)    │
└───────────────────────┬───────────────────────────┘
                        │ JSON over loopback HTTP
┌───────────────────────▼───────────────────────────┐
│ Express API (server/api/app.ts)                   │
│  zod validation · Host allowlist · JSON-only      │
│  mutations · user commands → Orchestrator         │
├───────────────────────────────────────────────────┤
│ Worker (server/worker.ts) ── tick() every 1s ──┐  │
│ Orchestrator (server/orchestrator/engine.ts)   │  │
│  planner · policy gate · verifier              │  │
├────────────────────────────────────────────────▼──┤
│ Adapter registry (server/adapters/)               │
│  demo (simulated) · manual handoff · OpenAI ·     │
│  Anthropic · GitHub                               │
├───────────────────────────────────────────────────┤
│ Store (server/store.ts) – SQLite via node:sqlite  │
│  projects · criteria · tasks · dispatches ·       │
│  artifacts · attention_items · events (audit)     │
└───────────────────────────────────────────────────┘
```

The server, worker and UI are TypeScript. `shared/types.ts` holds the domain model that both sides use.

## Orchestration loop

On every tick, the worker asks the orchestrator for projects that are `working` and due (`next_run_at <= now`). For each
project it acquires a **lease**, which is an atomic conditional `UPDATE` in SQLite with a TTL, and runs a single **step**:

1. **Resume open work.** If a dispatch is still open from a previous step or a previous process:
   - A handoff that you have answered is applied.
   - An external job (such as a GitHub issue) is polled. Transient poll errors back off without re-dispatching.
   - A dispatch interrupted by a crash is checked with the adapter's `recover()`. If the adapter can show the work never
     started, the task is retried. If the outcome cannot be determined, you are asked
     (`uncertain_dispatch`) rather than risking a duplicate.
2. **Enforce limits.** If spend has reached the budget or the step limit is reached, the project stops with a clear reason.
3. **Verify.** Every unverified acceptance criterion is evaluated against stored evidence (see below). When all criteria
   are verified, the project is **completed**.
4. **Plan** (`planner.ts`), in this order:
   - Run the next pending task.
   - A task that has used up its attempts becomes a blocker.
   - A criterion verified by you, whose task is done, raises a verification request.
   - Otherwise, create a task for the first unverified criterion.
5. **Gate** (`policy.ts`). The task's action kind is the more severe of what was declared and what is inferred from its
   text. That kind is checked against the project policy:
   - **deny** cancels the task, or blocks if a criterion depends on it.
   - **require approval** raises an approval item.
   - A **budget** item is raised if the estimate would exceed the budget.
   - A **checkpoint** is raised every *N* steps in supervised mode.
   - In manual autonomy, every dispatch requires approval.
6. **Dispatch.** A dispatch row is created with idempotency key `taskId:sequence`. Before the adapter is called, two
   unique indexes guarantee:
   - the same task attempt is never sent twice, and
   - a project has at most one open dispatch at a time.
7. **Apply the outcome.**
   - **pending**: poll later.
   - **handoff**: ask you.
   - **failed**: exponential backoff, honouring `retryAfter`. After `maxAttemptsPerTask` attempts, or on a non-retryable
     error, the task becomes a blocker.
   - **completed**: store the artifacts and checks, add any proposed tasks (classified by the policy), and re-verify.

Progress is measured, not claimed. A step counts as progress only if it verified a criterion or produced an artifact whose
content hash is new. After `stallLimit` consecutive steps without progress, the project is **blocked** as stalled.
Repeated identical output therefore cannot loop forever.

The engine re-checks project state before every write that depends on it (conditional `UPDATE ... WHERE state IN (...)`).
A pause or stop issued while an adapter call is in flight always wins. A result that arrives late is recorded but does
not continue the project. Stopping aborts the in-flight call through an `AbortSignal`.

## Completion verification

Each acceptance criterion has a rule type:

| Rule | Evidence |
| --- | --- |
| `artifact_exists` / `artifact_contains` | An artifact with that name exists, or contains the given text (case-insensitive). |
| `check_passed` | A check artifact reporting `PASSED`, accepted only from adapters that actually execute checks. Language-model "tests pass" claims are stored as plain text and never count. |
| `github_file_contains` | The file on the given branch in the configured repository contains the text, read live from the GitHub API. |
| `github_checks_pass` | Every check run on the ref has finished with a successful conclusion, read live from the GitHub API. |
| `manual` | You confirm it in the attention queue. |

The API rejects rule types that the chosen adapter cannot produce evidence for. The evidence text, including whether the
source was simulated, is stored with the verified criterion. Verified criteria stay verified; they are not re-checked
later.

## Persistence and recovery

All state is in SQLite (WAL mode, foreign keys on). This covers projects, criteria, tasks, dispatches, artifacts,
attention items, and an append-only events table that doubles as the audit trail.

On restart:

- Leases expire, at twice the dispatch timeout plus 60 seconds.
- Tasks left `in_progress` without an open dispatch are reset.
- Open dispatches are resumed or recovered as described above.

Because the store is the only coordination point, the API process and any number of `npm run worker` processes can share
a single database file.

## Security model

- **Authorization comes only from the user API.** Provider output and repository content are untrusted data:
  - Agent-proposed tasks are re-classified, and anything that looks like a deploy, merge or deletion is gated.
  - Output cannot change policy, limits or criteria.
  - Prompts mark context and output as untrusted.
  - Self-reported checks are not evidence.
- **Always gated:** `deploy_production`, `destructive` and unclassified (`other`) actions require approval whatever the
  policy or autonomy level.
- **Credentials** are read from server-side environment variables only. They are registered for redaction, and all
  persisted text passes through `redact()`. That function also masks common token formats (OpenAI, Anthropic and GitHub
  tokens, bearer headers, and key/password assignments).
- **Network:** the server binds to loopback by default and validates the `Host` header against DNS rebinding.
  Mutations must be `application/json`, which a cross-site form cannot send without a CORS preflight, and CORS is never
  granted. Responses carry `nosniff`, `DENY` framing and `no-referrer` headers.
- **UI:** it never renders provider HTML. Text goes through React escaping, and only `http(s)` URLs become links.
- **Provider safeguards:**
  - The provider's `Retry-After` header is honoured.
  - Retries are bounded.
  - GitHub polling is throttled (60 s by default).
  - No adapter scrapes or automates consumer web apps.
- **Audit:** every state change, dispatch, gate decision, settings change (with before and after values) and user
  decision is logged with its actor.

## Adding an adapter

Implement `ProviderAdapter` (`server/adapters/types.ts`):

- `describe()`: honest capabilities and limitations.
- `validateConfig()`
- `estimateCostCents()`
- `dispatch()`: must be idempotent per `idempotencyKey`, or recoverable.
- Optionally `poll()`, `recover()`, `checkRule()` and `submitHandoff()`.

Register it in `server/config.ts`. Mark simulated adapters `live: false`; the UI labels their work as simulated everywhere.

## Known limitations

- Single-user, no authentication. Meant for local use.
- The UI polls rather than streaming updates.
- Spend comes from token usage multiplied by the configured prices. It is an estimate, not a provider invoice.
- The planner is deterministic, with one task per unmet criterion plus agent-proposed tasks. It does not yet use a model
  to decompose goals.
