# Setup

## Requirements

- Node.js 20 or newer.
- A Plaid account.
- Plaid Sandbox credentials for fake test data, or Trial/Production credentials for real accounts.

## Install

```bash
npm install
cp .env.example .env
npm run migrate
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
npm install
npm run migrate
```

## Environment

`.env` controls credentials and local paths:

```env
PLAID_CLIENT_ID=
PLAID_SECRET=
PLAID_ENV=sandbox
DB_PATH=./data/finance.db
LINK_PORT=3000
LINK_REDIRECT_URI=
ETHOS_CURRENCY=CAD
ETHOS_USER_NAME=
ETHOS_COLOR=
```

Use separate databases for sandbox and real accounts:

```env
PLAID_ENV=sandbox
DB_PATH=./data/finance.db
```

```env
PLAID_ENV=production
DB_PATH=./data/finance-real.db
```

Never commit `.env` or `data/*.db*`.

## Link Institutions

Sandbox:

```bash
npm run link:sandbox
npm run sync
```

Real accounts:

```bash
npm run link
```

Open the printed local URL, complete Plaid Link, stop the server with `Ctrl+C`, then run:

```bash
npm run sync
node cli.js accounts
```

To connect another bank later:

```bash
npm run ethos
```

Then:

```text
ethos> /link start
```

If Plaid opens to an already linked institution, click `+ Add new account` inside the Plaid modal. That is Plaid's returning-user path to institution search.

## Verify

```bash
npm run codex:smoke
node cli.js status
node cli.js report month
```

`codex:smoke` does not need Plaid credentials. It checks syntax, migration, status JSON, and read-only `v_tx` access.
