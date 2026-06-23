# Agent Playbook

Use this when an AI coding agent is driving Ethos for a user.

## Rules

- Run a CLI command before stating any financial number.
- Use `node cli.js ...` for stable JSON.
- Do not read or print `.env`, `access_token`, Plaid secrets, or raw token-like values.
- Do not query `items`, `access_token`, `link_sessions`, or `link_token`; the CLI blocks this through `query`.
- Positive Plaid transaction amounts are outflows. Negative amounts are inflows.
- Ask for explicit user confirmation before writes:
  - `node cli.js tx categorize ...`
  - `node cli.js budget set ...`
  - `node cli.js budget rm ...`
  - `node cli.js item remove ... --confirm ...`
- Prefer exact dates and months.
- Keep explanations direct, numeric, and traceable to CLI output.

## First Move

For any finance question:

```bash
node cli.js status
```

If the user wants current data and did not ask for cached-only analysis:

```bash
node cli.js sync
```

If sync returns `needs_update: true` or `ITEM_LOGIN_REQUIRED`, tell the user to run:

```bash
npm run link:update
```

That opens Plaid Link update mode for the existing local Item. Do not create a duplicate Item to repair auth.

If the user needs more than the cached transaction history and the Item was linked with Plaid's default 90-day window, explain that Plaid cannot expand history on an existing Transactions Item. Ask for explicit confirmation before removing and relinking.

For a new relink, choose the history window needed for the task and pass it on the Link request, for example `npm run link -- --days 365`. Valid values are 1-730.

Then run the specific report or query needed.

## Safe Read Recipes

Current month:

```bash
node cli.js report month
```

Specific month:

```bash
node cli.js report month --month 2026-06
```

Recent transactions:

```bash
node cli.js tx list --limit 20
```

Cashflow:

```bash
node cli.js report cashflow
```

Custom read-only analysis:

```bash
node cli.js query "SELECT category, SUM(amount) AS spent FROM v_tx WHERE month = '2026-06' AND amount > 0 GROUP BY category ORDER BY spent DESC"
```

## Write Workflow

1. Read the current state.
2. Propose exact commands.
3. Ask the user to confirm.
4. Run the write commands only after confirmation.
5. Re-read to verify.

Example:

```text
I found 8 uncategorized transactions. I propose:
node cli.js tx categorize tx_123 Dining
node cli.js tx categorize tx_456 Groceries

Reply yes and I will apply these.
```

## What Agents Can Build

Agents can safely build:

- Budget setup flows.
- Category cleanup workflows.
- Monthly reports.
- Spending summaries.
- Scheduled sync instructions.
- Read-only dashboards or exports based on `v_tx`.
- Additional CLI commands that preserve JSON output.

Agents should not build features that upload financial data unless the user explicitly asks and understands the privacy tradeoff.
