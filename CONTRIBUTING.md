# Contributing to Powabase Agent Skills

Thanks for helping improve the Powabase agent skills! These skills make AI coding
assistants more accurate when building on Powabase, so correctness and precision
matter more than prose.

## Getting started

This project uses `pnpm` and the Node.js version in [`.node-version`](.node-version).

```bash
pnpm install
pnpm test
```

## Issues

Found a wrong endpoint, a stale field name, or a missing gotcha? Open an Issue.
Please search existing Issues first and include the page or endpoint affected.
Tag appropriately (`bug`, `enhancement`, `new-reference`, `documentation`).

## Pull requests

- Keep changes faithful to the [Powabase docs](https://docs.powabase.ai). If the
  docs and the live API disagree, note it in the PR.
- Use **conventional commit** titles so [Release Please](https://github.com/googleapis/release-please)
  can version correctly: `fix:` for a correction (patch), `feat:` for new coverage
  (minor).
- Run `pnpm test` before submitting.

### Adding a reference

1. Add `skills/powabase/references/<topic>.md`.
2. Link it from `skills/powabase/SKILL.md`'s reference index (the sanity test
   enforces that every reference is linked, and every link resolves).
3. `pnpm test`.

### Adding a new skill

See [AGENTS.md › Creating a new skill](AGENTS.md#creating-a-new-skill). Remember
to register it in `release-please-config.json` and `.release-please-manifest.json`.

## Releases

Merging to `main` lets Release Please open/update a release PR. Merging that PR
tags a version, packages each `skills/*` directory into a `.tar.gz`, and publishes
`dist/index.json` (agentskills discovery v0.2.0) as release assets.

## License

By contributing, you agree your contributions are licensed under the
[Apache License 2.0](LICENSE).
