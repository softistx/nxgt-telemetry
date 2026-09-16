# CLAUDE.md

This file exists so Claude Code picks up this repository's agent instructions.
It deliberately holds no guidance of its own.

## Read AGENTS.md first

**[AGENTS.md](./AGENTS.md) is the single source of truth.** Everything that
applies to any coding agent working here lives there: the five decisions this
library is built on, the layering, the build and the artifact check, how
releasing works, and the duplications that are deliberate.

## Skills

The skills come from the `nxgt-core` marketplace, enabled in the committed
`.claude/settings.json`: `nxgt-workflow` (`large-feature-branch-workflow`,
`write-a-repo-script`), `nxgt-package` (`create-a-package`,
`release-a-package-change`), `nxgt-docs` and `nxgt-review`. They are
authored in `softistx/nxgt-core`, under `plugins/`; nothing is copied here.

A skill that is genuinely only about this repository goes in
`.claude/skills/<name>/SKILL.md`.

The `code-reviewer` agent comes from `nxgt-review`; what it checks here is in
`plugins/nxgt-review/references/nxgt-telemetry.md` in nxgt-core. Run it
before opening a pull request; it reads and reports, and never edits.

## Keeping it that way

Add new agent guidance to `AGENTS.md`, never here. This file should only ever
grow content that is genuinely Claude Code-specific.
