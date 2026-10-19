# orchestrai

OrchestrAI is a local control center that keeps several AI-assisted projects moving toward **verified** completion. It
needs you only for decisions that actually require a human.

You give each project a goal, acceptance criteria, constraints, an authorization policy and limits. A background worker then
runs a durable loop for it:

1. Read the goal, criteria, constraints, context and your guidance.
2. Pick the next actionable task.
3. Dispatch it through an agent integration.
4. Collect the result.
5. Verify progress against the acceptance criteria.
6. Continue or escalate.

It stops when every criterion is verified by evidence, when you stop it, or when a limit is reached. An agent saying "done"
is never treated as completion.

> **Status: MVP.** The complete vertical slice works end-to-end with the clearly labeled **demo adapter** (simulated work)
> and with **manual handoff** (you relay prompts to ChatGPT, Claude, Lovable, etc.). The OpenAI, Anthropic and GitHub
> adapters use official APIs but have not been exercised against live accounts in CI. See
> [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for what each integration can and cannot do.

## Features

- **Control center.** Every project shows its goal, state, current activity, last meaningful progress, next action,
  criteria verified, spend and steps. The states are *working*, *ready to continue*, *awaiting approval*, *blocked*,
  *paused*, *completed* and *stopped*.
- **Attention queue.** Lists only real decisions: approvals for gated actions, budget increases, supervised checkpoints,
  manual handoffs, blockers, owner-confirmed criteria, and dispatches interrupted with an unknown outcome. You can resolve
  each item inline.
- **Project detail.** Tabs for criteria with completion evidence, tasks, activity and the audit log, dispatches,
  artifacts, attention history, and settings (autonomy, limits, per-action policy, adapter options, extra guidance).
- **Controls.** Start, pause, resume and stop. Three autonomy levels: *manual*, *supervised* and *autonomous*.
  Configurable budget, step limit, attempts per task and stall limit.
- **Safety.** Duplicate-dispatch prevention, cross-process leases, bounded retries with exponential backoff, stall
  detection, always-gated destructive and production actions, secret redaction and a full audit trail.

## Requirements

- **Node.js 22.13 or newer.** It uses the built-in `node:sqlite` module, so there are no native dependencies.
- npm 10+

## Setup

```bash
npm install
cp .env.example .env      # optional – only needed for OpenAI / Anthropic / GitHub or to change defaults
npm run dev
```

Open <http://127.0.0.1:5173>. Choose **Load demo projects** to see six simulated projects exercise the main flows:
completion, transient failures with retry, a premature "done" claim, a production deploy approval, a blocker that needs
your input, and stall detection. You can also choose **New project** to create your own.

`npm run dev` starts the API and worker on `127.0.0.1:8787` (with auto-reload) and the Vite dev server on port 5173, which
proxies `/api`.

### Production-style run

```bash
npm run build
npm start                 # serves the UI and API on http://127.0.0.1:8787
```

To run the worker as a separate process, set `WORKER_ENABLED=false` for the server and run `npm run worker` alongside it.
Projects are leased in SQLite, so several workers never process the same project at once.

### Other commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run the test suite (vitest) |
| `npm run typecheck` | Type-check server, tests and web |
| `npm run demo:seed` | Insert the demo projects from the command line |

## Configuration

All configuration comes from environment variables. See [`.env.example`](.env.example). Credentials are read only by the
server, never sent to the browser, and redacted from stored text and logs.

The API has **no user accounts**. It binds to loopback and refuses any other host unless `ORCHESTRAI_ALLOW_REMOTE=true`.
It also rejects requests whose `Host` header is not local, as DNS-rebinding protection. Before exposing it beyond your
machine, put an authenticating reverse proxy in front.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers components, the orchestration loop, persistence, guarantees and
  security model.
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) has the integration capability matrix and limitations.
