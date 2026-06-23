# Ethos

<p align="center">
  <img src="./assets/ethos-logo.png" alt="Ethos logo" width="132">
</p>

<p align="center">
  <strong>Local-first personal finance for humans, terminals, and coding agents.</strong>
</p>

<p align="center">
  <a href="#license">Non-commercial source-available</a> -
  <a href="./handbook/">Agent handbook</a> -
  <a href="./AGENTS.md">Codex / Claude guide</a>
</p>

Ethos is a Plaid-powered finance CLI that keeps your data on your machine. It gives you a friendly terminal shell for asking questions like "where did my money go this month?" and a deterministic JSON interface that agents like Codex, Claude Code, scripts, and scheduled jobs can use safely.

The shape is simple:

- `ethos.js` is the human shell. Type `ethos` and chat with your finances in a terminal.
- `cli.js` is the machine interface. Every command returns stable JSON for agents and automation.
- SQLite is the local cache for accounts, transactions, and budgets.
- Plaid Link connects banks and cards. Multiple institutions are supported.

Ethos does not ship with anyone's financial data. Your `.env`, Plaid access tokens, and SQLite databases stay local and are ignored by Git.

## Why This Exists

Most finance apps ask you to trust another dashboard. Ethos takes the opposite route: pull your own data, store it locally, and let your preferred tools reason over it with explicit commands.

Use it to:

- Inspect accounts and recent transactions from a terminal.
- Build monthly category budgets stored in SQLite.
- Ask an agent to categorize transactions after you approve the exact writes.
- Run scheduled syncs with cron, Task Scheduler, or systemd.
- Let Codex, Claude Code, or another coding agent query your finances without exposing Plaid secrets.

## Quick Start

Requirements:

- Node.js 20 or newer
- A Plaid developer account
- Plaid Sandbox credentials for fake data, or Trial/Production credentials for real accounts

```bash
npm install
cp .env.example .env
npm run migrate
npm run link:sandbox
npm run sync
npm run ethos
```

For real accounts, set `PLAID_ENV=production`, add your real Plaid credentials to `.env`, and use a separate database path:

```env
PLAID_ENV=production
PLAID_TRANSACTIONS_DAYS_REQUESTED=730
DB_PATH=./data/finance-real.db
```

Then link and sync:

```bash
npm run link
npm run sync
npm run ethos
```

If a bank later requires renewed consent, MFA, or OAuth repair, update the existing local Item instead of creating a duplicate connection:

```bash
npm run link:update
npm run sync
```

Install the local command if you want `ethos` available from your terminal:

```bash
npm link
ethos
ethos "accounts"
```

## Human Shell

```bash
npm run ethos
```

The shell opens with a Codex/Claude-style status panel showing the active Plaid environment, database, local cache counts, linked institutions, last sync time, and current directory.

Try:

```text
ethos> accounts
ethos> sync
ethos> where did my money go this month
ethos> month 2026-06
ethos> recent transactions
ethos> uncategorized
ethos> cashflow
ethos> /budget list
ethos> /link start
ethos> /link update
```

One-shot mode works well from other tools:

```bash
node ethos.js --once "accounts"
node ethos.js --once "where did my money go this month"
node ethos.js --json --once "/json report month --month 2026-06"
```

## Agent Interface

Agents should prefer `cli.js` because it prints JSON and has tighter boundaries.

```bash
node cli.js status
node cli.js sync
node cli.js auth status
node cli.js item list
node cli.js accounts
node cli.js tx list --limit 20
node cli.js report month --month 2026-06
node cli.js report cashflow
node cli.js budget list
node cli.js query "SELECT category, SUM(amount) AS spent FROM v_tx GROUP BY category ORDER BY spent DESC"
```

Write commands exist, but agents should ask for explicit user approval before running them:

```bash
node cli.js tx categorize <transaction_id> Dining
node cli.js budget set Dining 400
node cli.js budget rm Dining
```

Read [AGENTS.md](./AGENTS.md) for the short operating manual. The fuller handbook lives in [handbook/](./handbook/) and covers setup, commands, schema, budgets, and automation.

## Multiple Banks

Every bank or card login becomes a Plaid Item. You can connect more than one institution to the same local database.

```bash
npm run link
```

Or from inside the shell:

```text
ethos> /link start
```

If Plaid shows an already linked institution, choose `+ Add new account` inside the Plaid modal to search for another bank or issuer. After linking, run:

```bash
npm run sync
```

Ethos syncs all active Items for the current `PLAID_ENV`.

## Repairing Bank Auth

Sometimes Plaid returns `ITEM_LOGIN_REQUIRED` because your bank needs fresh MFA, renewed OAuth consent, or another user action. Ethos stores the existing Plaid access token in your local SQLite database, so agents do not need terminal-session auth. The repair flow creates a Plaid Link update-mode token from that local Item.

```bash
npm run sync
npm run link:update
npm run sync
```

From the shell:

```text
ethos> /sync
ethos> /link update
ethos> /sync
```

`sync` marks the affected Item with `needs_update: true` and returns `repair_command: "npm run link:update"`. `node cli.js auth status` shows the same local connection state without exposing access tokens.

## Transaction History Depth

Ethos requests 730 days of transaction history for new Plaid Items by default:

```env
PLAID_TRANSACTIONS_DAYS_REQUESTED=730
```

Agents and humans can override this for a single Link request without editing `.env`:

```bash
npm run link -- --days 365
node setup-link.js --days 180
node setup-link.js --sandbox --days 30
```

Inside the shell:

```text
ethos> /link start --days 365
```

Plaid defaults to 90 days if this is not set, which can make a "last 12 months" report only cover about 3 months. Plaid only applies `transactions.days_requested` when Transactions is first added to an Item. If an Item was originally linked with 90 days, rerunning sync or update mode cannot expand it; remove the Item and link it again:

```bash
node cli.js item list
node cli.js item remove <item_id> --confirm <item_id>
npm run link
npm run sync
```

Only run `item remove` after confirming you are ready to replace that local connection. It removes the Item at Plaid and deletes the local accounts/transactions for that Item.

## Budgets

Budgets are stored locally in the `budgets` table and are included in monthly reports.

```bash
node cli.js budget set Groceries 650
node cli.js budget set Dining 400
node cli.js report month --month 2026-06
```

The monthly report returns category spending, budget limits, remaining amounts, and an `over` boolean. See [handbook/budget-workflows.md](./handbook/budget-workflows.md) for categorization and review flows.

## Automation

Because everything important is available through deterministic commands, Ethos can run from scheduled jobs.

Examples:

```bash
node cli.js sync
node cli.js report month
node cli.js query "SELECT month, SUM(amount) AS spending FROM v_tx WHERE amount > 0 GROUP BY month"
```

See [handbook/automation.md](./handbook/automation.md) for Windows Task Scheduler, cron, and systemd examples.

## Data Model

Core tables:

- `items`: Plaid Items and access tokens stored locally. Treat this table like a secret.
- `accounts`: account metadata and balances.
- `transactions`: synced transaction records.
- `budgets`: user-defined monthly category limits.
- `link_sessions`: short-lived local Plaid Link session metadata for OAuth/update-mode resume.

Most reads should use the `v_tx` view. It joins transaction and account data and exposes a normalized `category` field:

```sql
COALESCE(user_category, category_primary, 'UNCATEGORIZED')
```

Read [handbook/data-model.md](./handbook/data-model.md) for the full schema and sign convention.

## Privacy And Safety

Ethos is local-first by design:

- `.env` is ignored.
- `data/*.db*` is ignored.
- `node_modules/` is ignored.
- Access-token-like fields are redacted from CLI JSON output.
- Read-only SQL only allows `SELECT` / `WITH`.
- SQL queries against `items`, `access_token`, `link_sessions`, or `link_token` are blocked.
- Sandbox and production Items are tagged by Plaid environment.

Before publishing your fork, run:

```bash
npm run codex:smoke
git status --short
```

Confirm no `.env`, `data/`, `node_modules/`, logs, exports, screenshots, or personal finance files are staged.

## Project Layout

```text
.
|-- AGENTS.md              # short operating guide for coding agents
|-- CLAUDE.md              # Claude Code entrypoint
|-- cli.js                 # deterministic JSON CLI
|-- ethos.js               # friendly terminal shell
|-- setup-link.js          # local Plaid Link flow
|-- lib/
|   |-- db.js              # SQLite schema and access helpers
|   `-- plaid.js           # Plaid client wrapper
|-- assets/                # logo and brand assets
`-- handbook/              # setup, commands, data model, budgets, automation
```

## License

Ethos is available under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0).

That means you can read, learn from, run, fork, and modify Ethos for personal, educational, nonprofit, research, and other non-commercial purposes. You cannot sell Ethos, sell hosted Ethos, bundle it into a paid product, or otherwise use it commercially without separate permission from the project owner.

Because this license restricts commercial use, Ethos is source-available rather than OSI-open-source in the strict definition. That tradeoff is intentional: the code is open for people, not for resale.
