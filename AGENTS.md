# StatusFlare project instructions

This directory is a standalone TypeScript/React/Cloudflare Workers project.
Parent-drive instructions describing an RTL/CPU repository do not describe this project.

- Keep changes inside this project unless the user explicitly requests otherwise.
- Preserve LICENSE, NOTICE, and applicable source attribution.
- Never copy deployment credentials, real database IDs, local databases, or original-repository Git history into distributable files.
- Use Node.js 22.13+. Verification commands: `npm test`, `npm run build`, `npm run build:worker`.
- Cloudflare deployments and remote D1 mutations require task authorization; local tests and migrations use `--local`.
- Runtime code: `server/`, frontend: `src/`, shared models/policy: `shared/`.
- Keep existing D1 migrations immutable after they have been deployed; add new numbered migrations for future schema changes.
- Keep `docs/DEPLOY.md` aligned with configuration names and GitHub Actions.
