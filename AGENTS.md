# AGENTS.md

Guidance for AI coding agents working **on this repository** (authoring and
maintaining the skills). If you are an agent trying to **use** Powabase, you want
[`skills/powabase/SKILL.md`](skills/powabase/SKILL.md), not this file.

> **Note:** `CLAUDE.md` is a symlink to this file.

## Repository structure

```
skills/
  powabase/
    SKILL.md
    references/      # load-on-demand topic files
scripts/build-release.ts
test/sanity.test.ts
.claude-plugin/marketplace.json
```

## Prerequisites & commands

Uses `pnpm` and the Node.js version in [`.node-version`](.node-version).

```bash
pnpm install            # install dependencies
pnpm test               # run the sanity tests
pnpm build:release      # build dist/*.tar.gz + dist/index.json (needs RELEASE_TAG, GITHUB_* env)
```

**Before completing any task**, run `pnpm test`.

## Writing SKILL.md files

A skill is **YAML frontmatter** followed by **Markdown instructions**, per the
[Agent Skills Open Standard](https://agentskills.io/).

### Frontmatter (required)

```yaml
---
name: powabase
description: What this skill does AND when to use it (this is the trigger).
license: MIT
metadata:
  author: powabase
  version: "0.0.0"
---
```

| Field         | Required | Constraints                                                                 |
| ------------- | -------- | --------------------------------------------------------------------------- |
| `name`        | Yes      | 1–64 chars. Lowercase alphanumeric + single hyphens. Must match the dir name. |
| `description` | Yes      | 1–1024 chars. Must state what the skill does **and** when to use it.         |
| `license`     | No       | License name.                                                               |
| `metadata`    | No       | Free-form. Always include `version: "0.0.0"` — Release Please bumps it.      |

The `description` is the **primary trigger** — Claude reads it to decide whether
to activate the skill, so pack it with concrete nouns/contexts. Do **not** put
"when to use" only in the body; the body loads after triggering.

### Body & progressive disclosure

Three loading levels: **metadata** (always loaded, ~100 tokens) → **body** (loaded
on trigger, keep lean) → **references** (loaded on demand). Keep `SKILL.md` tight
and push depth into `references/`. Write imperatively. Challenge every paragraph:
"does this earn its token cost?"

### Powabase-specific authoring rules

- **Be faithful to endpoints/enums/field names.** This skill's value is precision.
  Reproduce exact paths, request shapes, and enum values from the docs.
- **The `/api/*` surface is still moving.** Where a shape may drift, tell the agent
  to verify against the live docs (`https://docs.powabase.ai/...`) rather than
  trusting the snapshot. Flag documented ambiguities explicitly.
- **Default to safety.** Surface the security-critical footguns prominently (run
  agents from a trusted backend; `ai.*` RLS is project-wide; never ship the
  Service Role key client-side).
- **Hand off to the human** for Studio-only setup (credentials, BYOK keys, tool API
  keys) — say exactly where in the Studio to go.

## Creating a new skill

1. `mkdir -p skills/<name>/references`
2. Write `skills/<name>/SKILL.md` (frontmatter above).
3. Register it in [`release-please-config.json`](release-please-config.json)
   `packages` and seed `0.0.0` in
   [`.release-please-manifest.json`](.release-please-manifest.json) so its
   `metadata.version` stays in sync.
4. `pnpm test`
5. Commit with a `feat:` prefix so Release Please bumps it to `0.1.0` on first
   release.

## Releases

Automated via [Release Please](https://github.com/googleapis/release-please) on
`main`. Use conventional commits (`feat:` minor, `fix:` patch). Do not bump skill
versions by hand. `CHANGELOG.md` files are generated — do not edit them manually.

## What NOT to add to a skill

Skills contain only what an agent needs to do the job. No `README.md`,
`INSTALLATION.md`, or `QUICK_REFERENCE.md` inside a skill folder.
