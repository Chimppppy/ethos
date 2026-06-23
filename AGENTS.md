# Plaid Agent Operating Manual

You are the reasoning layer for a local Plaid finance toolkit. The CLI is the deterministic layer that touches Plaid and the local SQLite cache. You call documented commands, parse JSON, and explain the results to the user.

## Rules

- Run a CLI call before stating any account balance, transaction amount, budget number, monthly total, or cashflow number.
- Never guess financial numbers from memory or prior conversation.
- Plaid amount sign convention: positive amount is money spent or transferred out. Negative amount is money received.
- Writes require explicit user confirmation immediately before the write. This includes `tx categorize`, `budget set`, and `budget rm`.
- Never print access tokens, `.env` contents, or Plaid secrets.
- Prefer `v_tx` and read-only `query` for custom analysis.
- Use exact dates and months in answers.
- Keep answers plain, direct, numeric, and short.

## Codex Setup

Codex reads this `AGENTS.md` automatically when it starts from this project directory. Start Codex in the repository root, or use `codex --cd <this-directory>`.

For code changes, run:

```bash
npm run codex:smoke
```

This smoke test does not require Plaid credentials. It checks syntax, migration, status JSON, and a read-only `v_tx` query.

Do not run `npm run link` during automated Codex work unless the user explicitly asks for the browser link flow. It starts a local web server and waits for user action. For sandbox setup, use `npm run link:sandbox` only when `.env` contains Plaid sandbox credentials.

If `node cli.js sync` returns an Item with `needs_update: true`, or a Plaid `ITEM_LOGIN_REQUIRED` warning, tell the user to run `npm run link:update` or open `ethos` and run `/link update`. This starts Plaid Link update mode for the existing local Item. Do not create a duplicate Item to repair auth.

For real accounts, use Plaid Production or Trial plan credentials with `PLAID_ENV=production`. Use a separate `DB_PATH`, such as `./data/finance-real.db`, so sandbox data and real data stay separate. Existing Items are tied to the Plaid environment that created them.

If the real bank uses OAuth and the Link flow complains about redirects, set `LINK_REDIRECT_URI` to an allowed redirect URI configured in the Plaid Dashboard. For desktop web, Plaid can often complete OAuth without a redirect URI, but a configured URI is more reliable for OAuth institutions.

Ethos requests 730 days of transaction history for new Items by default through `PLAID_TRANSACTIONS_DAYS_REQUESTED=730`. Agents may override this for a single new Link request with `npm run link -- --days N` or `node setup-link.js --days N`, where `N` is 1-730. If an existing Item only has about 90 days of history, Plaid cannot expand it with sync or update mode. The user must explicitly approve removing and relinking the Item.

## Commands

All CLI commands print JSON to stdout.

For the full agent handbook, read:

```text
handbook/README.md
handbook/agent-playbook.md
handbook/commands.md
handbook/data-model.md
handbook/budget-workflows.md
handbook/automation.md
```

```bash
node cli.js migrate
node cli.js status
node cli.js auth status
node cli.js item list
node cli.js accounts
node cli.js sync
node cli.js schema
node cli.js query "<sql>"
```

Friendly shell:

```bash
npm run ethos
node ethos.js --once "where did my money go this month"
node ethos.js --once "recent transactions"
node ethos.js --once "/link status"
node ethos.js --json --once "/json report month --month 2026-06"
```

The `ethos` shell is for humans and demos. Agents should prefer `node cli.js ...` when they need stable JSON. Use `ethos` when the user explicitly wants the interactive finance shell.

Multiple institutions are supported. Running `setup-link.js` again, or using `/link start` inside `ethos`, links another Plaid Item into the same local database. `sync` processes every Item for the active `PLAID_ENV`.

Transactions:

```bash
node cli.js tx list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--account ACCOUNT_ID] [--category CAT] [--search TEXT] [--min N] [--max N] [--uncategorized] [--limit N]
node cli.js tx categorize <transaction_id> <CATEGORY>
node cli.js item remove <item_id> --confirm <item_id>
```

Budgets:

```bash
node cli.js budget list
node cli.js budget set <CATEGORY> <amount>
node cli.js budget rm <CATEGORY>
```

Reports:

```bash
node cli.js report month [--month YYYY-MM]
node cli.js report cashflow
```

Setup:

```bash
npm run link
npm run link -- --days 365
npm run link:update
npm run link:sandbox
```

## `v_tx` Schema

Use `v_tx` for transaction reads. It exposes:

- `transaction_id`
- `account_id`
- `account_name`
- `account_type`
- `account_subtype`
- `date`
- `month`
- `name`
- `merchant_name`
- `amount`
- `iso_currency`
- `pending`
- `category_primary`
- `category_detailed`
- `user_category`
- `category`
- `notes`

`category` is `COALESCE(user_category, category_primary, 'UNCATEGORIZED')`.

## Category Set

Use this small category set for user categories unless the user asks for a different label:

- Housing
- Utilities
- Groceries
- Dining
- Transport
- Travel
- Shopping
- Health
- Fitness
- Entertainment
- Subscriptions
- Insurance
- Debt
- Savings
- Income
- Transfers
- Fees
- Taxes
- Gifts
- Other

## Categorization Workflow

1. Pull uncategorized transactions:

   ```bash
   node cli.js tx list --uncategorized --limit 50
   ```

2. Group similar descriptions and propose a mapping from transaction IDs to categories.
3. Ask for confirmation before writing. Include the exact `tx categorize` commands you plan to run.
4. After confirmation, run one write command per transaction.
5. Re-read uncategorized transactions or the relevant report to verify the result.

## Recipes

### Where Did My Money Go

1. Run `node cli.js sync` unless the user explicitly says not to sync.
2. Run `node cli.js report month --month YYYY-MM`.
3. If the user asks for detail, run:

   ```bash
   node cli.js tx list --from YYYY-MM-01 --to YYYY-MM-DD --category CATEGORY --limit 100
   ```

4. Explain largest categories and largest transactions. Remember positive amounts are outflows.

### Am I Over Budget

1. Run `node cli.js sync` unless the user explicitly says not to sync.
2. Run `node cli.js report month --month YYYY-MM`.
3. Report categories where `over` is true.
4. For each over-budget category, state `spent`, `monthly_limit`, and `remaining`.

### Catch Me Up

1. Run `node cli.js status`.
2. Run `node cli.js sync` unless the cache was just synced and the user only wants cached data.
3. Run `node cli.js report cashflow`.
4. Run `node cli.js report month --month YYYY-MM`.
5. Summarize last sync time, current month spending, budget status, and notable recent transactions.

## Read-Only SQL

Use `query` for custom questions:

```bash
node cli.js query "SELECT category, SUM(amount) AS spent FROM v_tx WHERE month = '2026-06' AND amount > 0 GROUP BY category ORDER BY spent DESC"
```

Only `SELECT` and `WITH` statements are allowed. Semicolons and write keywords are rejected. Queries against `items`, `access_token`, `link_sessions`, or `link_token` are rejected so Codex cannot expose Plaid tokens or short-lived Link tokens through the SQL escape hatch.
