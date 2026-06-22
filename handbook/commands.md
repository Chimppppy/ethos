# Command Reference

All `cli.js` commands print JSON to stdout. This is the interface agents should use.

## Core

```bash
node cli.js migrate
node cli.js status
node cli.js auth status
node cli.js accounts
node cli.js sync
node cli.js schema
```

## Transactions

```bash
node cli.js tx list
node cli.js tx list --limit 20
node cli.js tx list --from 2026-06-01 --to 2026-06-30
node cli.js tx list --category FOOD_AND_DRINK
node cli.js tx list --search coffee
node cli.js tx list --min 20 --max 100
node cli.js tx list --uncategorized --limit 50
node cli.js tx categorize <transaction_id> <CATEGORY>
```

Filters:

- `--from YYYY-MM-DD`
- `--to YYYY-MM-DD`
- `--account ACCOUNT_ID`
- `--category CATEGORY`
- `--search TEXT`
- `--min NUMBER`
- `--max NUMBER`
- `--uncategorized`
- `--limit NUMBER`

## Budgets

```bash
node cli.js budget list
node cli.js budget set Dining 400
node cli.js budget set Groceries 650
node cli.js budget rm Dining
```

Budgets are stored in SQLite in the `budgets` table.

## Reports

```bash
node cli.js report month
node cli.js report month --month 2026-06
node cli.js report cashflow
```

`report month` returns spending by category, monthly budget limit, remaining amount, and an `over` boolean.

## Read-Only SQL

```bash
node cli.js query "SELECT month, SUM(amount) AS spending FROM v_tx WHERE amount > 0 GROUP BY month ORDER BY month"
```

Rules:

- Only `SELECT` and `WITH` are allowed.
- Semicolons are rejected.
- Write/schema keywords are rejected.
- `items` and `access_token` are rejected.
- `link_sessions` and `link_token` are rejected.

## Friendly Shell

```bash
npm run ethos
```

Inside:

```text
ethos> accounts
ethos> sync
ethos> /link start
ethos> /link update
ethos> where did my money go this month
ethos> month 2026-06
ethos> recent transactions
ethos> uncategorized
ethos> cashflow
ethos> /query SELECT category, SUM(amount) AS spent FROM v_tx GROUP BY category
```

One-shot mode:

```bash
node ethos.js --once "accounts"
node ethos.js --once "where did my money go this month"
node ethos.js --json --once "/json report month --month 2026-06"
```

Agents should prefer `cli.js` for automation and JSON parsing.

## Plaid Link

```bash
npm run link
npm run link:update
npm run link:sandbox
```

Use `npm run link` to connect another institution. Use `npm run link:update` when sync reports `ITEM_LOGIN_REQUIRED` or `needs_update: true`; it repairs the existing local Plaid Item instead of creating a duplicate connection.
