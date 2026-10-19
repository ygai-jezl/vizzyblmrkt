@AGENTS.md

## Claude Code

- The skills AGENTS.md names are in `.claude/skills/`: invoke the matching one before you start.
- The start hook runs `node scripts/doctor.mjs --brief`; its line says whether this machine is ready.
- `.claude/settings.json` asks before deploys, cloud changes and pushes, and blocks reading `.env.local`. Never work around it.
- Use plan mode for changes across several files. Run `npm run local` with `run_in_background`.
