# Integration capabilities

OrchestrAI separates two very different kinds of access:

- **Model API access.** Official, documented, key-authenticated HTTP APIs, such as the OpenAI API or the Anthropic
  Messages API. These are stateless: each call is a fresh request that has no knowledge of your chats or projects.
- **Consumer product access.** Your existing ChatGPT Projects, Claude.ai Projects and Lovable conversations. As of this
  writing, none of these products offers a supported public API for reading a conversation or posting a new turn on your
  behalf. OrchestrAI does **not** scrape, automate browsers or reuse session cookies to get around that. For these
  products it uses a **manual handoff** instead: it writes the next prompt, you paste it and the reply back, and it
  verifies the result.

## Matrix

| Integration | Adapter id | Status | Auth | What it can do | What it cannot do | Evidence it can produce |
| --- | --- | --- | --- | --- | --- | --- |
| **Demo agent** | `demo` | ✅ Works locally. **Simulated.** | None | Deterministic scenarios: happy path, flaky provider, premature "done", approval request, needs input, stall. Every artifact is labeled *simulated*. | Do any real work, or reach any network service. | Artifacts and "executed" checks, all labeled simulated |
| **Manual handoff** (ChatGPT, Claude, Lovable, other) | `manual` | ✅ Works | None. You relay the messages. | Writes a self-contained prompt from the goal, constraints, context, guidance and the criterion. Takes the reply you paste back, either as plain text or in the requested JSON format, and verifies it. | Read or write your conversations. Continue a chat without you. Run code. | Artifacts from the pasted reply. Owner confirmation. |
| **OpenAI API** | `openai` | ⚠️ Implemented, not live-tested in CI | `OPENAI_API_KEY` (server-side) | Calls Chat Completions in JSON mode with project context. Tracks token cost against the budget. | Access ChatGPT Projects, chats, memory or files. Execute code or tests. Any self-reported "tests pass" is **not** evidence. | Text and file artifacts (content checks) |
| **Anthropic API** | `anthropic` | ⚠️ Implemented, not live-tested in CI | `ANTHROPIC_API_KEY` (server-side) | Calls the Messages API with project context. Tracks token cost against the budget. | Access Claude.ai Projects, chats or project knowledge. Execute code or tests. | Text and file artifacts (content checks) |
| **GitHub** | `github` | ⚠️ Implemented, not live-tested in CI | `GITHUB_TOKEN` (fine-grained PAT, server-side) | Opens one issue per task, labeled `orchestrai` and carrying a hidden dispatch marker so a restart never creates a duplicate. Polls the issue and can assign it to a user or agent. Verifies criteria by reading repository files and check-run results. | Guarantee that an assignee (including a GitHub coding agent) acts on the issue; that depends on your plan and repository settings. Track Copilot or Actions billing. Merge or deploy. | `github_file_contains`, `github_checks_pass` (read live from the repository) |
| **Lovable** | – | ❌ No API adapter | – | Use **manual handoff** with target "Lovable". If the Lovable project syncs to GitHub, use **GitHub** rules to verify what was actually committed. | Programmatic continuation of Lovable chats. | Via manual handoff or GitHub |
| **ChatGPT / Claude.ai Projects** | – | ❌ No API adapter | – | Use **manual handoff**, or the stateless model APIs with your context pasted into the project. | Read or continue existing project conversations. | Via manual handoff |

## Notes and caveats

- **Closing a GitHub issue is not completion.** When an issue closes, the result is treated as a claim of completion. The
  criteria are still checked against repository evidence. An issue closed as *not planned* fails the task.
- **Cost tracking:**
  - OpenAI and Anthropic spend is estimated from reported token usage multiplied by the prices in `.env`. Update those
    prices for your model.
  - GitHub adapter calls are recorded as $0. Any coding-agent or Actions usage is billed by GitHub outside OrchestrAI.
- **Rate limits:** `Retry-After` and rate-limit responses back off. Retries are bounded by `maxAttemptsPerTask`, and
  GitHub polling defaults to once a minute.
- **Untrusted output:** replies from every provider, including what you paste in a manual handoff, are parsed as data.
  They can propose tasks, which are then classified and gated, but they cannot change policy, limits or criteria.
- **Simulated work is never shown as live.** Demo projects carry a `DEMO · simulated` badge. Their artifacts are flagged
  `simulated`, and their completion evidence says *SIMULATED*.

If you know of an officially supported API for any of the products marked ❌, contributions are welcome. Implement
`ProviderAdapter` as described in [ARCHITECTURE.md](ARCHITECTURE.md#adding-an-adapter).
