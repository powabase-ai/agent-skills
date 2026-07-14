# Publishing & distribution

How this skill reaches users across the AI ecosystems, what's automatic vs. a
manual submission, and the roadmap for the channels that need the (forthcoming)
Powabase MCP server.

> **The key fact:** a "skill" (`SKILL.md`) is a **cross-vendor open standard**
> ([agentskills.io](https://agentskills.io)), read natively by Claude Code, GitHub
> Copilot, Cursor, OpenAI Codex, and Google Gemini CLI. So this one repo already
> works across Anthropic + OpenAI + Google **coding agents** — most "publishing" is
> just keeping the repo public and getting listed in a few directories.

There are two categories of marketplace, and they take different artifacts:

| Category | Examples | Artifact they accept | Our status |
| --- | --- | --- | --- |
| **Coding-agent skills** | Claude Code, Copilot, Cursor, Codex, Gemini CLI, Windsurf, Cline | a `SKILL.md` skill (this repo) | ✅ **Track A — shippable now** |
| **Consumer / chat-agent** | ChatGPT Apps directory, Gemini Enterprise, GPT Store, Google Cloud Marketplace | an **MCP server**, custom GPT, or A2A agent — **not** a markdown skill | 🔜 **Track B — needs the Powabase MCP server** |

---

## Track A — coding-agent channels (available now)

### How users install it today (no submission required)

Because the repo is public and ships the open `SKILL.md` standard plus per-ecosystem
manifests, users can already install it directly:

| Tool | Command |
| --- | --- |
| Any (cross-agent installer) | `npx skills add powabase-ai/agent-skills` |
| GitHub CLI / Copilot | `gh skill install powabase-ai/agent-skills` |
| Google Gemini CLI | `gemini extensions install https://github.com/powabase-ai/agent-skills` |
| Claude Code (plugin) | `claude plugin marketplace add powabase-ai/agent-skills` → `claude plugin install powabase@powabase-agent-skills` |
| Cursor / OpenAI Codex / Windsurf / Cline / … | the cross-agent installers above place `SKILL.md` in each tool's skills dir; or copy `skills/powabase/` into the tool's skills directory |

The per-ecosystem manifests in this repo that make the above "just work":
- `.claude-plugin/marketplace.json` — Claude Code plugin marketplace.
- `gemini-extension.json` + `GEMINI.md` — Google Gemini CLI extension (auto-indexed by the [Gemini CLI extensions gallery](https://geminicli.com/extensions/) for public repos).
- `skills/powabase/agents/openai.yaml` — OpenAI Codex skill UI/invocation metadata.
- The skill itself (`skills/powabase/SKILL.md`) — the cross-vendor source of truth.

### Get listed (manual web actions — a maintainer must do these)

A coding assistant can't submit these forms; they're one-time human steps.

1. **Anthropic `claude-community` marketplace** — the public community marketplace where
   third-party submissions land after review (distinct from `claude-plugins-official`, the
   Anthropic-curated marketplace, which has no application process). Users add ours with
   `/plugin marketplace add anthropics/claude-plugins-community` and install it as
   `@claude-community` once it's live. To submit:
   - **Validate locally first:** `claude plugin validate .` (add `--strict` to catch metadata
     warnings). The review pipeline runs the same check plus automated safety screening. The
     plugin is wrapped via `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json`.
   - **Submit via the in-app form** (a coding assistant can't fill these; a maintainer must):
     - **claude.ai:** `claude.ai/admin-settings/directory/submissions/plugins/new` — requires a
       **Team or Enterprise** org with directory-management access (org Owners have it by default).
     - **Console:** `platform.claude.com/plugins/submit` — the path for individual authors who
       aren't part of a Team/Enterprise org.
   - **After approval:** the plugin is pinned to a specific commit SHA in the
     `anthropics/claude-plugins-community` catalog, and CI bumps that pin automatically as you
     push new commits. The public catalog syncs **nightly**, so expect a delay between approval
     and the plugin appearing in `marketplace.json` — check by searching for its name in the
     community catalog to confirm it's installable.
2. **cursor.directory** — submit the repo at **cursor.directory/plugins/new** (sign in
   with GitHub, paste the repo URL). It auto-detects `skills/*/SKILL.md` via the "Open
   Plugins" standard; no PR needed.
3. **Gemini CLI extensions gallery** — public repos with a valid `gemini-extension.json`
   are auto-indexed; if it doesn't appear, open an issue on `google-gemini/gemini-cli`.
4. **GitHub `gh skill publish`** — run from the repo to validate + register against the
   spec; optionally PR into [`github/awesome-copilot`](https://github.com/github/awesome-copilot).
5. **Smithery Skills** ([smithery.ai/skills](https://smithery.ai/skills)) and crawler
   directories (Glama-style) index public GitHub repos automatically.
6. **awesome-lists (PRs):** `VoltAgent/awesome-agent-skills`, `awesome-claude-skills`,
   `github/awesome-copilot`.

> **Framing note:** several skill directories down-rank or reject skills that "just
> wrap one commercial API." Frame the listing around the **open-source repo and open
> developer workflows** (it documents an entire BaaS+AI platform's REST surface, runs
> on self-hostable Powabase, and works with BYOK keys), and lead with usage/stars.

---

## Track B — consumer / chat-agent marketplaces (roadmap; needs the MCP server)

These marketplaces do **not** accept a markdown skill. The cross-vendor primitive
they consume is an **MCP server** — and Anthropic, OpenAI, and Google all consume
MCP. Powabase's MCP server is the "coming soon" placeholder noted in the skill; once
it ships, one server unlocks most of these at once:

1. **Publish the MCP server to the official MCP Registry**
   (`registry.modelcontextprotocol.io`) with the `mcp-publisher` CLI — namespace
   `io.github.powabase-ai/*` (GitHub auth) or `ai.powabase/*` if you DNS-verify the
   domain. The registry is a "registry of registries": one publish fans out to
   **Smithery, PulseMCP, Glama, mcp.so, and the VS Code MCP gallery**.
2. **OpenAI — ChatGPT Apps directory** ([Apps SDK](https://developers.openai.com/apps-sdk)):
   an "app" *is* a hosted MCP server (Streamable HTTP). Submit for review; approval
   also yields usage in the Responses/Agents APIs and an auto-generated Codex plugin.
   (Non-EU at launch.)
3. **Google — Gemini CLI / ADK / Gemini Enterprise** all consume MCP servers; a
   listing in the **Google Cloud AI Agent Marketplace** additionally needs an A2A
   Agent Card pointing at a hosted, deployed agent + approved-partner onboarding
   (heavier, enterprise-oriented).
4. **No-server OpenAI option (today):** a **custom GPT** for the GPT Store that wraps
   the Powabase REST API as OpenAPI "Actions" — built in the ChatGPT UI (needs builder
   verification + a privacy-policy URL). Reaches chat end-users, not coding agents.

> ⚠️ **Avoid OpenAI AgentKit / Agent Builder** as a publishing target — it's being
> deprecated (unavailable after Nov 30, 2026), and it was never a public marketplace.

---

## Optional next steps (not built yet)

Declined for the current pass; easy to add later:
- **Per-tool rule shims** generated from the skill (Cursor `.cursor/rules/*.mdc`,
  `.github/copilot-instructions.md`, a Continue Hub rule block, Windsurf rules) for
  tools that prefer "rules" over skills.
- **A live `.well-known` discovery endpoint** — serve the released `dist/index.json`
  at `/.well-known/agent-skills/index.json` (agentskills discovery v0.2.0), ideally on
  `powabase.ai`/`docs.powabase.ai` for branded discovery (website-team handoff), or via
  GitHub Pages for the repo.
- **The custom-GPT + OpenAPI starter** for the GPT Store (Track B, no server).
