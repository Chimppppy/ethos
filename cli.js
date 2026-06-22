#!/usr/bin/env node

import {
  categorizeTransaction,
  listAccounts,
  listBudgets,
  listItemsWithTokens,
  listTransactions,
  markItemSynced,
  migrate,
  openDb,
  removeBudget,
  removeTransaction,
  reportCashflow,
  reportMonth,
  schema,
  setBudget,
  status,
  upsertAccount,
  upsertTransaction
} from './lib/db.js';
import { getPlaidClient } from './lib/plaid.js';

function printJson(value) {
  process.stdout.write(`${JSON.stringify(redactSecrets(value), null, 2)}\n`);
}

function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /token|secret|password|api[_-]?key/i.test(key) ? '[REDACTED]' : redactSecrets(entry)
      ])
    );
  }
  return value;
}

function fail(message, details = undefined) {
  printJson({
    ok: false,
    error: message,
    ...(details ? { details } : {})
  });
  process.exitCode = 1;
}

function errorDetails(error) {
  const responseData = error.response?.data;
  if (responseData && typeof responseData === 'object') {
    return {
      plaid_error: responseData
    };
  }
  return undefined;
}

function parseOptions(args) {
  const options = {};
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replaceAll('-', '_');
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }

    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      i += 1;
    }
  }

  return { options, positional };
}

function parseNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${name} must be a number`);
  }
  return number;
}

function parseLimit(value) {
  if (value === undefined || value === true) {
    return 50;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }
  return limit;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function lastMonths(count) {
  const now = new Date();
  const months = [];

  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(date.toISOString().slice(0, 7));
  }

  return months;
}

function assertReadOnlySql(sql) {
  const trimmed = sql.trim();
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error('query only allows SELECT or WITH statements');
  }
  if (trimmed.includes(';')) {
    throw new Error('query rejects semicolons');
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA|ATTACH)\b/i.test(trimmed)) {
    throw new Error('query rejects write or schema keywords');
  }
  if (/\b(items|access_token)\b/i.test(trimmed)) {
    throw new Error('query cannot read items or access_token; use status for item metadata');
  }
}

async function sync(db) {
  const items = listItemsWithTokens(db);

  if (!items.length) {
    return {
      items: [],
      totals: {
        accounts: 0,
        added: 0,
        modified: 0,
        removed: 0
      }
    };
  }

  const client = getPlaidClient();
  const totals = {
    accounts: 0,
    added: 0,
    modified: 0,
    removed: 0
  };
  const results = [];

  for (const item of items) {
    const itemResult = {
      item_id: item.item_id,
      institution_name: item.institution_name,
      accounts: 0,
      added: 0,
      modified: 0,
      removed: 0,
      has_cursor: false,
      warnings: []
    };

    let accountsResponse;
    try {
      accountsResponse = await client.accountsBalanceGet({
        access_token: item.access_token
      });
    } catch (error) {
      itemResult.warnings.push({
        step: 'accountsBalanceGet',
        message: error.message,
        details: errorDetails(error)
      });
      accountsResponse = await client.accountsGet({
        access_token: item.access_token
      });
    }

    const upsertAccounts = db.transaction((accounts) => {
      for (const account of accounts) {
        upsertAccount(db, item.item_id, account);
      }
    });
    upsertAccounts(accountsResponse.data.accounts);
    itemResult.accounts = accountsResponse.data.accounts.length;
    totals.accounts += itemResult.accounts;

    let cursor = item.cursor || undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await client.transactionsSync({
        access_token: item.access_token,
        cursor,
        count: 500
      });
      const data = response.data;
      const applyChanges = db.transaction(() => {
        for (const transaction of data.added) {
          upsertTransaction(db, transaction);
        }
        for (const transaction of data.modified) {
          upsertTransaction(db, transaction);
        }
        for (const transaction of data.removed) {
          removeTransaction(db, transaction.transaction_id);
        }
      });
      applyChanges();

      itemResult.added += data.added.length;
      itemResult.modified += data.modified.length;
      itemResult.removed += data.removed.length;
      totals.added += data.added.length;
      totals.modified += data.modified.length;
      totals.removed += data.removed.length;

      cursor = data.next_cursor;
      hasMore = data.has_more;
    }

    markItemSynced(db, item.item_id, cursor);
    itemResult.has_cursor = Boolean(cursor);
    results.push(itemResult);
  }

  return { items: results, totals };
}

async function main() {
  const args = process.argv.slice(2);
  const [command, subcommand, ...rest] = args;
  const db = migrate(openDb());

  if (!command) {
    throw new Error('command is required');
  }

  if (command === 'migrate') {
    printJson({ ok: true, db_path: status(db).db_path });
    return;
  }

  if (command === 'status') {
    printJson({ ok: true, ...status(db) });
    return;
  }

  if (command === 'accounts') {
    printJson({ ok: true, accounts: listAccounts(db) });
    return;
  }

  if (command === 'sync') {
    printJson({ ok: true, ...(await sync(db)) });
    return;
  }

  if (command === 'schema') {
    printJson({ ok: true, schema: schema(db) });
    return;
  }

  if (command === 'query') {
    const sql = [subcommand, ...rest].filter(Boolean).join(' ');
    if (!sql) {
      throw new Error('query requires SQL');
    }
    assertReadOnlySql(sql);
    printJson({ ok: true, rows: db.prepare(sql).all() });
    return;
  }

  if (command === 'tx') {
    if (subcommand === 'list') {
      const { options } = parseOptions(rest);
      const rows = listTransactions(db, {
        from: options.from,
        to: options.to,
        account: options.account,
        category: options.category,
        search: options.search,
        min: options.min === undefined ? undefined : parseNumber(options.min, 'min'),
        max: options.max === undefined ? undefined : parseNumber(options.max, 'max'),
        uncategorized: Boolean(options.uncategorized),
        limit: parseLimit(options.limit)
      });
      printJson({ ok: true, transactions: rows });
      return;
    }

    if (subcommand === 'categorize') {
      const [transactionId, category] = rest;
      if (!transactionId || !category) {
        throw new Error('tx categorize requires transaction_id and CATEGORY');
      }
      const changes = categorizeTransaction(db, transactionId, category);
      printJson({ ok: true, changed: changes, transaction_id: transactionId, category });
      return;
    }
  }

  if (command === 'budget') {
    if (subcommand === 'list') {
      printJson({ ok: true, budgets: listBudgets(db) });
      return;
    }

    if (subcommand === 'set') {
      const [category, amount] = rest;
      if (!category || amount === undefined) {
        throw new Error('budget set requires CAT and amount');
      }
      const monthlyLimit = parseNumber(amount, 'amount');
      if (monthlyLimit < 0) {
        throw new Error('amount must be non-negative');
      }
      setBudget(db, category, monthlyLimit);
      printJson({ ok: true, category, monthly_limit: monthlyLimit });
      return;
    }

    if (subcommand === 'rm') {
      const [category] = rest;
      if (!category) {
        throw new Error('budget rm requires CAT');
      }
      const changes = removeBudget(db, category);
      printJson({ ok: true, changed: changes, category });
      return;
    }
  }

  if (command === 'report') {
    if (subcommand === 'month') {
      const { options } = parseOptions(rest);
      const month = options.month || currentMonth();
      if (!/^\d{4}-\d{2}$/.test(month)) {
        throw new Error('month must be YYYY-MM');
      }
      printJson({ ok: true, report: reportMonth(db, month) });
      return;
    }

    if (subcommand === 'cashflow') {
      printJson({ ok: true, cashflow: reportCashflow(db, lastMonths(12)) });
      return;
    }
  }

  throw new Error(`unknown command: ${args.join(' ')}`);
}

main().catch((error) => {
  fail(error.message, errorDetails(error));
});
