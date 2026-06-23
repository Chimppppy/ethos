# Data Model

Ethos stores a local SQLite cache at `DB_PATH`, defaulting to `./data/finance.db`.

SQLite runs with:

- WAL mode.
- Foreign keys enabled.
- A busy timeout for short concurrent CLI calls.

## Tables

### `items`

One row per Plaid Item, meaning one institution login.

Columns:

- `item_id` primary key.
- `access_token` Plaid token. Do not print.
- `plaid_env` such as `sandbox` or `production`.
- `institution_name`.
- `cursor` Plaid transactions sync cursor. Do not print unless debugging privately.
- `last_synced_at`.
- `needs_update` marks Items that need Plaid Link update mode.
- `last_error_code`, `last_error_message`, and `last_error_at` store the latest local sync auth error without exposing tokens.

Transaction history depth is Link-time Plaid configuration, not an `items` column. New Link sessions request `PLAID_TRANSACTIONS_DAYS_REQUESTED`, which defaults to 730.

### `accounts`

One row per financial account.

Columns:

- `account_id` primary key.
- `item_id` foreign key.
- `name`.
- `type`.
- `subtype`.
- `mask`.
- `current_balance`.
- `available_balance`.
- `iso_currency`.

### `transactions`

One row per Plaid transaction.

Columns:

- `transaction_id` primary key.
- `account_id` foreign key.
- `date`.
- `name`.
- `merchant_name`.
- `amount`.
- `iso_currency`.
- `pending`.
- `category_primary`.
- `category_detailed`.
- `user_category`.
- `notes`.

Plaid sign convention:

- Positive amount is money out.
- Negative amount is money in.

### `budgets`

Custom monthly budgets.

Columns:

- `category` primary key.
- `monthly_limit`.

Budgets are user-controlled and local. The CLI writes this table through:

```bash
node cli.js budget set <CATEGORY> <amount>
node cli.js budget rm <CATEGORY>
```

### `link_sessions`

Short-lived local Plaid Link session records for OAuth/update-mode resume.

Columns:

- `session_id` primary key.
- `mode` (`create` or `update`).
- `plaid_env`.
- `item_id`.
- `link_token`.
- `created_at`.
- `completed_at`.

Treat `link_token` as local auth material. Agents must not query this table.

## View: `v_tx`

Use `v_tx` for reads. It joins transactions to account names and adds:

- `account_name`
- `account_type`
- `account_subtype`
- `month`
- `category`

`category` is:

```sql
COALESCE(user_category, category_primary, 'UNCATEGORIZED')
```

Useful query:

```bash
node cli.js query "SELECT category, SUM(amount) AS spent FROM v_tx WHERE month = '2026-06' AND amount > 0 GROUP BY category ORDER BY spent DESC"
```

## Data Boundaries

Do not commit:

- `.env`
- `data/*.db*`
- logs containing financial data
- exported CSV/JSON reports unless the user explicitly wants them tracked

For open-source examples, use Sandbox data only.

`node cli.js query` blocks direct access to `items`, `access_token`, `link_sessions`, and `link_token`.
