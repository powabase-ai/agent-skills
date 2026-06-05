# Powabase Agent Skills

Agent Skills that help developers using AI coding assistants build on
[Powabase](https://powabase.ai) — the multi-tenant **AI Backend-as-a-Service**.
Agent Skills are folders of instructions and resources that an agent discovers
and loads on demand to work more accurately and efficiently. Compatible with
Claude Code and any agent that supports the
[Agent Skills](https://agentskills.io/) open standard.

> **Powabase in one line:** a single REST API that replaces the usual AI stack —
> a vector DB for RAG, an agent framework for tool use, a workflow engine for
> automation — alongside a full Supabase-style backend (Postgres + pgvector,
> PostgREST, Auth, Storage, Realtime). This skill teaches your assistant to drive
> all of it over plain HTTP.

## Installation

### With the `skills` CLI

```bash
# Install the skill
npx skills add powabase-ai/agent-skills
```

### As a Claude Code plugin

```bash
# 1. Add this repo as a plugin marketplace
claude plugin marketplace add powabase-ai/agent-skills

# 2. Install the plugin
claude plugin install powabase@powabase-agent-skills
```

### Manually

Copy `skills/powabase/` into your agent's skills directory (for Claude Code,
that's `.claude/skills/powabase/` in your project or `~/.claude/skills/`).

## Available skills

<details>
<summary><strong>powabase</strong></summary>

End-to-end Powabase development skill covering the agentic `/api/*` surface and
the BaaS layer.

**Use when:**

- Building RAG: uploading documents (Sources), creating Knowledge Bases,
  choosing an indexing strategy (`chunk_embed`, `full_document`, `page_index`,
  `graph_index`, `doc2json`) and a retrieval method (vector, full-text, hybrid,
  tree search), reranking, and metadata enrichment.
- Building agents: ReAct agents with builtin/custom/MCP tools, sessions,
  approval (human-in-the-loop) flows, and streaming.
- Multi-agent orchestration (supervisor / sequential / parallel coordinators).
- Workflow automation: block graphs, webhooks, scheduled triggers, the Copilot.
- Consuming Server-Sent Events for agents, orchestrations, and workflows.
- The Powabase BaaS layer: PostgREST, RLS, GoTrue auth, Storage, Realtime, and
  direct Postgres — including the `ai.*` schema.
- Connecting and authenticating, choosing the right API key, handling billing /
  rate-limit / error responses, and knowing when to hand off to a human for
  Studio-only setup.

</details>

## How it works

The skill ships a lean `SKILL.md` (connection, decision trees, the canonical RAG
flow, and the highest-value gotchas) plus detailed `references/` files that the
agent loads only when relevant — keeping context small until depth is needed.

Content is synthesized from the [Powabase docs](https://docs.powabase.ai). Because
the agentic `/api/*` surface is still evolving, the skill instructs agents to
**verify shapes against the live docs** rather than trusting a frozen snapshot.

## Skill structure

```
skills/
└── powabase/
    ├── SKILL.md        # required manifest (frontmatter) + core instructions
    └── references/     # detailed, load-on-demand topic files
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: edit the Markdown, run
`pnpm test`, and open a PR with a conventional-commit title (`feat:` / `fix:`).

## Releases & `.well-known` discovery

Each release packages every directory under `skills/` into its own `.tar.gz` and
publishes a `dist/index.json` discovery document (agentskills schema v0.2.0)
alongside the tarballs, built by [`scripts/build-release.ts`](scripts/build-release.ts)
and driven by [Release Please](https://github.com/googleapis/release-please).

## License

[MIT](LICENSE)
