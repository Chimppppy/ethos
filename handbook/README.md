# Ethos Handbook

This folder is the setup and operating manual for humans, Codex, Claude Code, and other coding agents using Ethos.

Read these in order:

1. [Setup](./setup.md): install, configure Plaid, link institutions, and choose databases.
2. [Agent Playbook](./agent-playbook.md): rules for agents, safe workflows, and confirmation boundaries.
3. [Command Reference](./commands.md): JSON CLI commands and friendly shell commands.
4. [Data Model](./data-model.md): SQLite tables, `v_tx`, sign convention, and safe SQL.
5. [Budget Workflows](./budget-workflows.md): custom budgets, categorization, and monthly reviews.
6. [Automation](./automation.md): scheduled syncs, budget checks, and maintenance recipes.

Core idea:

- `cli.js` is the deterministic JSON interface for agents and scripts.
- `ethos.js` is the friendly terminal shell for humans.
- SQLite is the local cache and budget store.
- Plaid tokens and financial data stay local.

Agents should prefer `node cli.js ...` for stable JSON. Use `npm run ethos` only when the user explicitly wants the interactive shell.
