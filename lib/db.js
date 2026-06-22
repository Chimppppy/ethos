import Database from 'better-sqlite3';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DB_PATH = './data/finance.db';

function currentPlaidEnv() {
  return (process.env.PLAID_ENV || 'sandbox').toLowerCase();
}

export function resolveDbPath() {
  return path.resolve(process.env.DB_PATH || DEFAULT_DB_PATH);
}

export function openDb() {
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  return db;
}

export function migrate(db = openDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      item_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      plaid_env TEXT NOT NULL DEFAULT 'sandbox',
      institution_name TEXT,
      cursor TEXT,
      last_synced_at TEXT,
      needs_update INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      last_error_message TEXT,
      last_error_at TEXT
    );

    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
      name TEXT,
      type TEXT,
      subtype TEXT,
      mask TEXT,
      current_balance REAL,
      available_balance REAL,
      iso_currency TEXT
    );

    CREATE TABLE IF NOT EXISTS transactions (
      transaction_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
      date TEXT,
      name TEXT,
      merchant_name TEXT,
      amount REAL,
      iso_currency TEXT,
      pending INTEGER,
      category_primary TEXT,
      category_detailed TEXT,
      user_category TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS budgets (
      category TEXT PRIMARY KEY,
      monthly_limit REAL NOT NULL CHECK (monthly_limit >= 0)
    );

    CREATE TABLE IF NOT EXISTS link_sessions (
      session_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('create', 'update')),
      plaid_env TEXT NOT NULL DEFAULT 'sandbox',
      item_id TEXT REFERENCES items(item_id) ON DELETE CASCADE,
      link_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    DROP VIEW IF EXISTS v_tx;

    CREATE VIEW v_tx AS
      SELECT
        t.transaction_id,
        t.account_id,
        a.name AS account_name,
        a.type AS account_type,
        a.subtype AS account_subtype,
        t.date,
        strftime('%Y-%m', t.date) AS month,
        t.name,
        t.merchant_name,
        t.amount,
        t.iso_currency,
        t.pending,
        t.category_primary,
        t.category_detailed,
        t.user_category,
        COALESCE(t.user_category, t.category_primary, 'UNCATEGORIZED') AS category,
        t.notes
      FROM transactions t
      JOIN accounts a ON a.account_id = t.account_id;
  `);

  const itemColumns = new Set(db.prepare('PRAGMA table_info(items)').all().map((column) => column.name));
  const itemColumnDefinitions = {
    plaid_env: "TEXT NOT NULL DEFAULT 'sandbox'",
    needs_update: 'INTEGER NOT NULL DEFAULT 0',
    last_error_code: 'TEXT',
    last_error_message: 'TEXT',
    last_error_at: 'TEXT'
  };

  for (const [column, definition] of Object.entries(itemColumnDefinitions)) {
    if (!itemColumns.has(column)) {
      db.exec(`ALTER TABLE items ADD COLUMN ${column} ${definition}`);
    }
  }

  const linkSessionColumns = new Set(db.prepare('PRAGMA table_info(link_sessions)').all().map((column) => column.name));
  if (!linkSessionColumns.has('plaid_env')) {
    db.exec("ALTER TABLE link_sessions ADD COLUMN plaid_env TEXT NOT NULL DEFAULT 'sandbox'");
  }

  return db;
}

export function upsertItem(db, item) {
  db.prepare(`
    INSERT INTO items (item_id, access_token, plaid_env, institution_name, cursor, last_synced_at)
    VALUES (@item_id, @access_token, @plaid_env, @institution_name, @cursor, @last_synced_at)
    ON CONFLICT(item_id) DO UPDATE SET
      access_token = excluded.access_token,
      plaid_env = excluded.plaid_env,
      institution_name = excluded.institution_name
  `).run({
    item_id: item.item_id,
    access_token: item.access_token,
    plaid_env: item.plaid_env ?? currentPlaidEnv(),
    institution_name: item.institution_name ?? null,
    cursor: item.cursor ?? null,
    last_synced_at: item.last_synced_at ?? null
  });
}

export function listItems(db) {
  return db.prepare(`
    SELECT
      item_id,
      plaid_env,
      institution_name,
      cursor IS NOT NULL AS has_cursor,
      last_synced_at,
      needs_update,
      last_error_code,
      last_error_message,
      last_error_at
    FROM items
    ORDER BY plaid_env, institution_name, item_id
  `).all().map((item) => ({
    ...item,
    has_cursor: Boolean(item.has_cursor),
    needs_update: Boolean(item.needs_update)
  }));
}

export function listItemsWithTokens(db) {
  return db.prepare(`
    SELECT
      item_id,
      access_token,
      plaid_env,
      institution_name,
      cursor,
      last_synced_at,
      needs_update,
      last_error_code,
      last_error_message,
      last_error_at
    FROM items
    WHERE plaid_env = ?
    ORDER BY institution_name, item_id
  `).all(currentPlaidEnv());
}

export function markItemSynced(db, itemId, cursor) {
  db.prepare(`
    UPDATE items
    SET
      cursor = ?,
      last_synced_at = ?,
      needs_update = 0,
      last_error_code = NULL,
      last_error_message = NULL,
      last_error_at = NULL
    WHERE item_id = ?
  `).run(cursor, new Date().toISOString(), itemId);
}

export function markItemNeedsUpdate(db, itemId, errorCode, errorMessage) {
  db.prepare(`
    UPDATE items
    SET
      needs_update = 1,
      last_error_code = ?,
      last_error_message = ?,
      last_error_at = ?
    WHERE item_id = ?
  `).run(errorCode ?? 'ITEM_LOGIN_REQUIRED', errorMessage ?? null, new Date().toISOString(), itemId);
}

export function clearItemNeedsUpdate(db, itemId) {
  db.prepare(`
    UPDATE items
    SET
      needs_update = 0,
      last_error_code = NULL,
      last_error_message = NULL,
      last_error_at = NULL
    WHERE item_id = ?
  `).run(itemId);
}

export function getItemWithToken(db, itemId) {
  return db.prepare(`
    SELECT item_id, access_token, plaid_env, institution_name, cursor, last_synced_at,
           needs_update, last_error_code, last_error_message, last_error_at
    FROM items
    WHERE plaid_env = ? AND item_id = ?
  `).get(currentPlaidEnv(), itemId);
}

export function firstItemForUpdate(db) {
  return db.prepare(`
    SELECT item_id, access_token, plaid_env, institution_name, cursor, last_synced_at,
           needs_update, last_error_code, last_error_message, last_error_at
    FROM items
    WHERE plaid_env = ?
    ORDER BY needs_update DESC, last_error_at DESC, institution_name, item_id
    LIMIT 1
  `).get(currentPlaidEnv());
}

export function createLinkSession(db, session) {
  const createdAt = new Date().toISOString();
  db.prepare(`
    UPDATE link_sessions
    SET completed_at = ?
    WHERE completed_at IS NULL AND plaid_env = ?
  `).run(createdAt, currentPlaidEnv());

  db.prepare(`
    INSERT INTO link_sessions (session_id, mode, plaid_env, item_id, link_token, created_at, completed_at)
    VALUES (@session_id, @mode, @plaid_env, @item_id, @link_token, @created_at, NULL)
  `).run({
    session_id: session.session_id,
    mode: session.mode,
    plaid_env: currentPlaidEnv(),
    item_id: session.item_id ?? null,
    link_token: session.link_token,
    created_at: createdAt
  });
}

export function completeLinkSession(db, sessionId) {
  db.prepare(`
    UPDATE link_sessions
    SET completed_at = ?
    WHERE session_id = ?
  `).run(new Date().toISOString(), sessionId);
}

export function latestOpenLinkSession(db) {
  return db.prepare(`
    SELECT session_id, mode, item_id, link_token, created_at
    FROM link_sessions
    WHERE completed_at IS NULL AND plaid_env = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(currentPlaidEnv());
}

export function upsertAccount(db, itemId, account) {
  db.prepare(`
    INSERT INTO accounts (
      account_id, item_id, name, type, subtype, mask, current_balance,
      available_balance, iso_currency
    )
    VALUES (
      @account_id, @item_id, @name, @type, @subtype, @mask, @current_balance,
      @available_balance, @iso_currency
    )
    ON CONFLICT(account_id) DO UPDATE SET
      item_id = excluded.item_id,
      name = excluded.name,
      type = excluded.type,
      subtype = excluded.subtype,
      mask = excluded.mask,
      current_balance = excluded.current_balance,
      available_balance = excluded.available_balance,
      iso_currency = excluded.iso_currency
  `).run({
    account_id: account.account_id,
    item_id: itemId,
    name: account.name ?? null,
    type: account.type ?? null,
    subtype: account.subtype ?? null,
    mask: account.mask ?? null,
    current_balance: account.balances?.current ?? null,
    available_balance: account.balances?.available ?? null,
    iso_currency: account.balances?.iso_currency_code ?? null
  });
}

export function upsertTransaction(db, transaction) {
  db.prepare(`
    INSERT INTO transactions (
      transaction_id, account_id, date, name, merchant_name, amount, iso_currency,
      pending, category_primary, category_detailed, user_category, notes
    )
    VALUES (
      @transaction_id, @account_id, @date, @name, @merchant_name, @amount, @iso_currency,
      @pending, @category_primary, @category_detailed, NULL, NULL
    )
    ON CONFLICT(transaction_id) DO UPDATE SET
      account_id = excluded.account_id,
      date = excluded.date,
      name = excluded.name,
      merchant_name = excluded.merchant_name,
      amount = excluded.amount,
      iso_currency = excluded.iso_currency,
      pending = excluded.pending,
      category_primary = excluded.category_primary,
      category_detailed = excluded.category_detailed
  `).run({
    transaction_id: transaction.transaction_id,
    account_id: transaction.account_id,
    date: transaction.date ?? null,
    name: transaction.name ?? null,
    merchant_name: transaction.merchant_name ?? null,
    amount: transaction.amount ?? null,
    iso_currency: transaction.iso_currency_code ?? transaction.unofficial_currency_code ?? null,
    pending: transaction.pending ? 1 : 0,
    category_primary: transaction.personal_finance_category?.primary ?? null,
    category_detailed: transaction.personal_finance_category?.detailed ?? null
  });
}

export function removeTransaction(db, transactionId) {
  db.prepare('DELETE FROM transactions WHERE transaction_id = ?').run(transactionId);
}

export function status(db) {
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM items) AS items,
      (SELECT COUNT(*) FROM accounts) AS accounts,
      (SELECT COUNT(*) FROM transactions) AS transactions,
      (SELECT COUNT(*) FROM budgets) AS budgets,
      (SELECT MAX(last_synced_at) FROM items) AS last_synced_at
  `).get();

  return {
    db_path: resolveDbPath(),
    counts,
    items: listItems(db)
  };
}

export function listAccounts(db) {
  return db.prepare(`
    SELECT account_id, item_id, name, type, subtype, mask, current_balance,
           available_balance, iso_currency
    FROM accounts
    ORDER BY name, account_id
  `).all();
}

export function listTransactions(db, filters) {
  const where = [];
  const params = {};

  if (filters.from) {
    where.push('date >= @from');
    params.from = filters.from;
  }
  if (filters.to) {
    where.push('date <= @to');
    params.to = filters.to;
  }
  if (filters.account) {
    where.push('account_id = @account');
    params.account = filters.account;
  }
  if (filters.category) {
    where.push('category = @category');
    params.category = filters.category;
  }
  if (filters.search) {
    where.push('(name LIKE @search OR merchant_name LIKE @search OR notes LIKE @search)');
    params.search = `%${filters.search}%`;
  }
  if (filters.min !== undefined) {
    where.push('amount >= @min');
    params.min = filters.min;
  }
  if (filters.max !== undefined) {
    where.push('amount <= @max');
    params.max = filters.max;
  }
  if (filters.uncategorized) {
    where.push("category = 'UNCATEGORIZED'");
  }

  const limit = Number.isInteger(filters.limit) && filters.limit > 0 ? filters.limit : 50;
  params.limit = Math.min(limit, 1000);

  const sql = `
    SELECT *
    FROM v_tx
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY date DESC, transaction_id
    LIMIT @limit
  `;

  return db.prepare(sql).all(params);
}

export function categorizeTransaction(db, transactionId, category) {
  const result = db.prepare(`
    UPDATE transactions
    SET user_category = ?
    WHERE transaction_id = ?
  `).run(category, transactionId);
  return result.changes;
}

export function listBudgets(db) {
  return db.prepare(`
    SELECT category, monthly_limit
    FROM budgets
    ORDER BY category
  `).all();
}

export function setBudget(db, category, monthlyLimit) {
  db.prepare(`
    INSERT INTO budgets (category, monthly_limit)
    VALUES (?, ?)
    ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit
  `).run(category, monthlyLimit);
}

export function removeBudget(db, category) {
  return db.prepare('DELETE FROM budgets WHERE category = ?').run(category).changes;
}

export function reportMonth(db, month) {
  const spending = db.prepare(`
    SELECT category, SUM(amount) AS spent, COUNT(*) AS transaction_count
    FROM v_tx
    WHERE month = ? AND amount > 0
    GROUP BY category
  `).all(month);
  const budgets = listBudgets(db);
  const categories = new Map();

  for (const row of spending) {
    categories.set(row.category, {
      category: row.category,
      spent: row.spent ?? 0,
      transaction_count: row.transaction_count,
      monthly_limit: null,
      remaining: null,
      over: false
    });
  }

  for (const budget of budgets) {
    const existing = categories.get(budget.category) ?? {
      category: budget.category,
      spent: 0,
      transaction_count: 0
    };
    const remaining = budget.monthly_limit - existing.spent;
    categories.set(budget.category, {
      ...existing,
      monthly_limit: budget.monthly_limit,
      remaining,
      over: existing.spent > budget.monthly_limit
    });
  }

  const rows = [...categories.values()].sort((a, b) => b.spent - a.spent || a.category.localeCompare(b.category));
  const totalSpent = rows.reduce((sum, row) => sum + row.spent, 0);
  const totalBudgeted = budgets.reduce((sum, row) => sum + row.monthly_limit, 0);

  return {
    month,
    totals: {
      spent: totalSpent,
      budgeted: totalBudgeted,
      remaining: totalBudgeted - totalSpent
    },
    categories: rows
  };
}

export function reportCashflow(db, months) {
  const startMonth = months[0];
  const rows = db.prepare(`
    SELECT
      month,
      SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS income,
      SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS spending
    FROM v_tx
    WHERE month >= ?
    GROUP BY month
    ORDER BY month
  `).all(startMonth);
  const byMonth = new Map(rows.map((row) => [row.month, row]));

  return months.map((month) => {
    const row = byMonth.get(month);
    const income = row?.income ?? 0;
    const spending = row?.spending ?? 0;
    return {
      month,
      income,
      spending,
      net: income - spending
    };
  });
}

export function schema(db) {
  return db.prepare(`
    SELECT type, name, sql
    FROM sqlite_schema
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
}
