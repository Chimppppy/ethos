#!/usr/bin/env node

import 'dotenv/config';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(ROOT_DIR, 'cli.js');
const SETUP_LINK_PATH = path.join(ROOT_DIR, 'setup-link.js');
const DISPLAY_CURRENCY = process.env.ETHOS_CURRENCY || 'CAD';
const VERSION = '0.1.0';
const COLOR = process.env.ETHOS_COLOR === '1' || (process.env.NO_COLOR === undefined && output.isTTY);
let linkServer = null;

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  white: '\x1b[37m',
  bgGold: '\x1b[48;5;220m',
  bgAmber: '\x1b[48;5;214m',
  bgShadow: '\x1b[48;5;58m'
};

const HELP = `
Ethos finance shell

Ask in plain English:
  accounts
  sync
  where did my money go this month
  month 2026-06
  recent transactions
  uncategorized
  cashflow
  budgets

Direct commands:
  /accounts
  /sync
  /month [YYYY-MM]
  /recent [limit]
  /uncategorized [limit]
  /cashflow
  /budget list
  /budget set <CATEGORY> <amount>
  /budget rm <CATEGORY>
  /link start
  /link status
  /link stop
  /query <SELECT ...>
  /json <raw cli args>
  /help
  /exit

Agents can always use the deterministic JSON CLI underneath:
  node cli.js report month --month 2026-06
`;

function style(text, ...codes) {
  if (!COLOR) {
    return text;
  }
  return `${codes.join('')}${text}${ansi.reset}`;
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(text) {
  return stripAnsi(text).length;
}

function truncate(text, maxLength) {
  const plain = stripAnsi(text);
  if (plain.length <= maxLength) {
    return text;
  }
  return `${plain.slice(0, Math.max(0, maxLength - 3))}...`;
}

function padRight(text, width) {
  const length = visibleLength(text);
  return `${text}${' '.repeat(Math.max(0, width - length))}`;
}

function terminalWidth() {
  return Math.max(78, Math.min(output.columns || 118, 118));
}

function relativeDirectory() {
  return path.basename(ROOT_DIR) || ROOT_DIR;
}

function dbNameFromStatus(statusJson) {
  if (statusJson?.db_path) {
    return path.basename(statusJson.db_path);
  }
  return path.basename(process.env.DB_PATH || './data/finance.db');
}

function envName() {
  return (process.env.PLAID_ENV || 'sandbox').toLowerCase();
}

function displayUserName() {
  const configured = cleanName(process.env.ETHOS_USER_NAME);
  if (configured) {
    return configured;
  }

  if (process.platform === 'win32') {
    try {
      const fullName = execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        "$name=$env:USERNAME; (Get-CimInstance Win32_UserAccount -Filter \"Name='$name'\").FullName"
      ], {
        encoding: 'utf8',
        timeout: 1500,
        windowsHide: true
      });
      const cleaned = cleanName(fullName);
      if (cleaned) {
        return cleaned;
      }
    } catch {
      // Fall through to the portable username path.
    }
  }

  return cleanName(process.env.USER || process.env.USERNAME || os.userInfo().username) || 'friend';
}

function cleanName(value) {
  const name = String(value ?? '').trim();
  if (!name) {
    return '';
  }
  return name
    .split(/\s+/)
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : part)
    .join(' ');
}

function renderBox(lines) {
  const width = Math.min(78, terminalWidth() - 2);
  const inner = width - 4;
  const top = `+${'-'.repeat(width - 2)}+`;
  const bottom = top;
  const body = lines.map((line) => `| ${padRight(truncate(line, inner), inner)} |`);
  return [top, ...body, bottom].join('\n');
}

function renderSplitBox(leftLines, rightLines) {
  const width = Math.min(118, terminalWidth() - 2);
  const leftWidth = 44;
  const rightWidth = width - leftWidth - 7;

  if (rightWidth < 34) {
    return renderBox([...leftLines, '', ...rightLines]);
  }

  const top = `+${'-'.repeat(leftWidth + 2)}+${'-'.repeat(rightWidth + 2)}+`;
  const rowCount = Math.max(leftLines.length, rightLines.length);
  const rows = [];

  for (let index = 0; index < rowCount; index += 1) {
    const left = leftLines[index] ?? '';
    const right = rightLines[index] ?? '';
    rows.push(`| ${padRight(truncate(left, leftWidth), leftWidth)} | ${padRight(truncate(right, rightWidth), rightWidth)} |`);
  }

  return [top, ...rows, top].join('\n');
}

function renderEthosMark() {
  if (!COLOR) {
    return [
      '      ####      ',
      '    ########    ',
      '   ####  ####   ',
      '  ###      ###  ',
      '################',
      '   ||    ||     '
    ].map((line) => style(line, ansi.yellow));
  }

  const rows = [
    '......yyyy......',
    '....yyyyyyyy....',
    '...yyyyyyyyyy...',
    '..yyyy....yyyy..',
    '.yyyy......yyyy.',
    '.yyy........yyy.',
    'yyyyyyyyyyyyyyyy',
    'yyyooyyyoyyyooyy',
    '...ooyyy.oyyyoo.',
    '...oo....oyyoo..'
  ];

  const fill = {
    y: ansi.bgGold,
    o: ansi.bgAmber
  };

  return rows.map((row) => {
    const leftPad = '    ';
    const cells = [...row].map((cell) => {
      if (cell === '.') {
        return '  ';
      }
      const color = fill[cell];
      return style('  ', color);
    }).join('');
    return `${leftPad}${cells}`;
  });
}

async function loadShellStatus() {
  const result = await runCli(['status']);
  return result.json.ok ? result.json : null;
}

function renderBanner(statusJson) {
  const counts = statusJson?.counts ?? {};
  const itemCount = counts.items ?? 0;
  const accountCount = counts.accounts ?? 0;
  const txCount = counts.transactions ?? 0;
  const lastSync = counts.last_synced_at ? counts.last_synced_at.slice(0, 19).replace('T', ' ') : 'never';
  const banks = (statusJson?.items ?? []).map((item) => item.institution_name || item.item_id).filter(Boolean);
  const bankSummary = banks.length ? `${banks.slice(0, 3).join(', ')}${banks.length > 3 ? ` +${banks.length - 3} more` : ''}` : 'none yet';
  const userName = displayUserName();
  const icon = renderEthosMark();

  console.log(style('Launching Ethos', ansi.dim));
  console.log(style('[!] Local finance data is private. Keep .env and data/*.db* out of Git.', ansi.yellow));
  console.log();
  console.log(renderSplitBox([
    `${style('>_', ansi.gray)} ${style('Ethos Finance', ansi.bold, ansi.white)} ${style(`v${VERSION}`, ansi.dim)}`,
    '',
    `${style('Welcome back', ansi.bold)} ${userName}!`,
    '',
    ...icon,
    '',
    `${style(envName(), ansi.yellow)} . ${style('local SQLite', ansi.cyan)} . ${style('agent-ready', ansi.magenta)}`,
    `${dbNameFromStatus(statusJson)}`,
    `${relativeDirectory()}`
  ], [
    `${style('Quick commands', ansi.bold)}`,
    `${style('/sync', ansi.cyan)} refresh Plaid and local cache`,
    `${style('/link start', ansi.cyan)} connect another bank`,
    `${style('accounts', ansi.cyan)} list balances`,
    `${style('where did my money go', ansi.cyan)} month report`,
    '',
    `${style('Finance cache', ansi.bold)}`,
    `${compactNumber(itemCount)} institution connection(s)`,
    `${compactNumber(accountCount)} account(s), ${compactNumber(txCount)} transaction(s)`,
    `banks: ${bankSummary}`,
    `synced: ${lastSync}`
  ]));
  console.log();
  console.log(`${style('Tip:', ansi.bold)} Try ${style('where did my money go this month', ansi.white)} or run ${style('/sync', ansi.cyan)} to refresh.`);
  console.log();
}

function shellPrompt() {
  return `${style('ethos', ansi.bold, ansi.yellow)} ${style(envName(), ansi.magenta)} ${style('fast', ansi.green)} ${style('.', ansi.gray)} ${style(relativeDirectory(), ansi.gray)}\n${style('>', ansi.white)} `;
}

function money(value, currency = DISPLAY_CURRENCY) {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2
  }).format(number);
}

function compactNumber(value) {
  return Number(value ?? 0).toLocaleString('en-CA', {
    maximumFractionDigits: 2
  });
}

function tokenize(input) {
  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;

  while ((match = pattern.exec(input)) !== null) {
    tokens.push((match[1] ?? match[2] ?? match[3]).replaceAll('\\"', '"').replaceAll("\\'", "'"));
  }

  return tokens;
}

function parseMonth(text) {
  const exact = text.match(/\b(20\d{2}-\d{2})\b/);
  if (exact) {
    return exact[1];
  }

  const now = new Date();
  if (/\blast month\b/i.test(text)) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  }
  if (/\bthis month\b/i.test(text)) {
    return now.toISOString().slice(0, 7);
  }

  const monthNames = new Map([
    ['january', '01'], ['jan', '01'],
    ['february', '02'], ['feb', '02'],
    ['march', '03'], ['mar', '03'],
    ['april', '04'], ['apr', '04'],
    ['may', '05'],
    ['june', '06'], ['jun', '06'],
    ['july', '07'], ['jul', '07'],
    ['august', '08'], ['aug', '08'],
    ['september', '09'], ['sep', '09'],
    ['october', '10'], ['oct', '10'],
    ['november', '11'], ['nov', '11'],
    ['december', '12'], ['dec', '12']
  ]);

  for (const [name, month] of monthNames.entries()) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(text)) {
      const year = text.match(/\b(20\d{2})\b/)?.[1] ?? String(now.getUTCFullYear());
      return `${year}-${month}`;
    }
  }

  return null;
}

function parseLimit(text, fallback = 20) {
  const number = text.match(/\b(\d{1,4})\b/)?.[1];
  if (!number) {
    return fallback;
  }
  const limit = Number(number);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : fallback;
}

function parseLine(line) {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();

  if (!trimmed) {
    return { type: 'empty' };
  }

  if (['exit', 'quit', '/exit', '/quit', ':q'].includes(lower)) {
    return { type: 'exit' };
  }

  if (['help', '/help', '?'].includes(lower)) {
    return { type: 'help' };
  }

  if (['clear', '/clear'].includes(lower)) {
    return { type: 'clear' };
  }

  if (/\b(connect|link|add)\b.*\b(bank|account|institution)\b/.test(lower)) {
    return { type: 'link', action: 'start' };
  }

  if (lower.startsWith('/json ')) {
    return { type: 'raw-json', args: tokenize(trimmed.slice('/json '.length)) };
  }

  if (lower.startsWith('/query ')) {
    return { type: 'command', args: ['query', trimmed.slice('/query '.length)], format: 'query' };
  }

  if (lower.startsWith('/')) {
    return commandFromTokens(tokenize(trimmed.slice(1)));
  }

  if (lower.startsWith('node cli.js ')) {
    return { type: 'raw-json', args: tokenize(trimmed.slice('node cli.js '.length)) };
  }

  if (lower.startsWith('cli ')) {
    return { type: 'raw-json', args: tokenize(trimmed.slice('cli '.length)) };
  }

  if (lower.startsWith('query ')) {
    return { type: 'command', args: ['query', trimmed.slice('query '.length)], format: 'query' };
  }

  if (/\b(sync|refresh|update)\b/.test(lower)) {
    return { type: 'command', args: ['sync'], format: 'sync' };
  }

  if (/\b(account|accounts|balances|balance)\b/.test(lower)) {
    return { type: 'command', args: ['accounts'], format: 'accounts' };
  }

  if (/\b(cashflow|cash flow|income|net)\b/.test(lower)) {
    return { type: 'command', args: ['report', 'cashflow'], format: 'cashflow' };
  }

  if (/\b(uncategorized|uncategorised)\b/.test(lower)) {
    return {
      type: 'command',
      args: ['tx', 'list', '--uncategorized', '--limit', String(parseLimit(lower, 50))],
      format: 'transactions'
    };
  }

  if (/\b(recent|latest|transactions|purchases|charges)\b/.test(lower)) {
    return {
      type: 'command',
      args: ['tx', 'list', '--limit', String(parseLimit(lower, 20))],
      format: 'transactions'
    };
  }

  if (/\b(budget|budgets|over budget)\b/.test(lower)) {
    const month = parseMonth(lower);
    if (/\blist\b/.test(lower) && !month) {
      return { type: 'command', args: ['budget', 'list'], format: 'budgets' };
    }
    return monthCommand(month);
  }

  if (/\b(where did my money go|spend|spending|spent|month|monthly|report)\b/.test(lower)) {
    return monthCommand(parseMonth(lower));
  }

  return {
    type: 'unknown',
    message: 'I can answer accounts, sync, month reports, recent transactions, uncategorized items, cashflow, budgets, and read-only SQL. Type /help for examples.'
  };
}

function commandFromTokens(tokens) {
  const [first, second, ...rest] = tokens;

  if (!first) {
    return { type: 'empty' };
  }

  if (first === 'status') {
    return { type: 'command', args: ['status'], format: 'status' };
  }
  if (first === 'sync') {
    return { type: 'command', args: ['sync'], format: 'sync' };
  }
  if (first === 'accounts') {
    return { type: 'command', args: ['accounts'], format: 'accounts' };
  }
  if (first === 'link' || first === 'connect') {
    return { type: 'link', action: second ?? 'start' };
  }
  if (first === 'month' || (first === 'report' && second === 'month')) {
    const month = tokens.find((token) => /^\d{4}-\d{2}$/.test(token));
    return monthCommand(month);
  }
  if (first === 'cashflow' || (first === 'report' && second === 'cashflow')) {
    return { type: 'command', args: ['report', 'cashflow'], format: 'cashflow' };
  }
  if (first === 'recent') {
    return { type: 'command', args: ['tx', 'list', '--limit', String(parseLimit(tokens.join(' '), 20))], format: 'transactions' };
  }
  if (first === 'uncategorized' || first === 'uncategorised') {
    return {
      type: 'command',
      args: ['tx', 'list', '--uncategorized', '--limit', String(parseLimit(tokens.join(' '), 50))],
      format: 'transactions'
    };
  }
  if (first === 'budget') {
    return { type: 'command', args: ['budget', second ?? 'list', ...rest], format: second === 'list' || !second ? 'budgets' : 'write' };
  }
  if (first === 'categorize' || first === 'categorise') {
    return { type: 'command', args: ['tx', 'categorize', second, ...rest].filter(Boolean), format: 'write' };
  }
  if (first === 'tx') {
    return { type: 'command', args: ['tx', second ?? 'list', ...rest], format: second === 'list' || !second ? 'transactions' : 'write' };
  }
  if (first === 'schema') {
    return { type: 'command', args: ['schema'], format: 'schema' };
  }

  return { type: 'raw-json', args: tokens };
}

function monthCommand(month) {
  const args = ['report', 'month'];
  if (month) {
    args.push('--month', month);
  }
  return { type: 'command', args, format: 'month' };
}

function needsConfirmation(args) {
  return (
    (args[0] === 'tx' && args[1] === 'categorize') ||
    (args[0] === 'budget' && ['set', 'rm'].includes(args[1]))
  );
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: ROOT_DIR,
      env: process.env,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      try {
        const json = JSON.parse(stdout || '{}');
        resolve({ code, json, stdout, stderr });
      } catch (error) {
        resolve({
          code,
          json: {
            ok: false,
            error: 'CLI did not return JSON',
            stdout,
            stderr,
            parse_error: error.message
          },
          stdout,
          stderr
        });
      }
    });
  });
}

function linkStatusText() {
  if (linkServer?.process && !linkServer.process.killed) {
    const url = linkServer.url ?? 'starting...';
    return `Plaid Link server is running: ${url}`;
  }
  return 'Plaid Link server is not running. Use /link start to connect another institution.';
}

function startLinkServer() {
  if (linkServer?.process && !linkServer.process.killed) {
    return linkStatusText();
  }

  const child = spawn(process.execPath, [SETUP_LINK_PATH], {
    cwd: ROOT_DIR,
    env: process.env,
    windowsHide: true
  });
  linkServer = {
    process: child,
    url: null
  };

  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const payload = JSON.parse(line);
        if (payload.ok && payload.url) {
          linkServer.url = payload.url;
          console.log(`\nPlaid Link ready: ${style(payload.url, ansi.cyan)}`);
          if (payload.port_changed) {
            console.log(`Port ${payload.requested_port} was busy, so Ethos used ${payload.port}.`);
          }
          console.log('Open that URL, click Connect account, and complete Plaid Link. You can connect multiple institutions from the same page.');
        } else {
          console.log(`\n${JSON.stringify(payload, null, 2)}`);
        }
      } catch {
        console.log(`\n${line}`);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    console.log(`\n${String(chunk).trim()}`);
  });

  child.on('close', (code) => {
    if (linkServer?.process === child) {
      linkServer = null;
    }
    if (code !== 0 && code !== null) {
      console.log(`\nPlaid Link server exited with code ${code}.`);
    }
  });

  return 'Starting Plaid Link server...';
}

function stopLinkServer() {
  if (!linkServer?.process || linkServer.process.killed) {
    linkServer = null;
    return 'Plaid Link server is not running.';
  }

  linkServer.process.kill();
  linkServer = null;
  return 'Plaid Link server stopped.';
}

function handleLinkCommand(action) {
  const normalized = String(action ?? 'start').toLowerCase();
  if (['start', 'run', 'open', 'bank', 'banks'].includes(normalized)) {
    return startLinkServer();
  }
  if (['status', 'info'].includes(normalized)) {
    return linkStatusText();
  }
  if (['stop', 'kill', 'close'].includes(normalized)) {
    return stopLinkServer();
  }
  return 'Use /link start, /link status, or /link stop.';
}

function formatResult(result, format) {
  const json = result.json;

  if (!json.ok) {
    return formatError(json);
  }

  if (format === 'status') {
    return formatStatus(json);
  }
  if (format === 'sync') {
    return formatSync(json);
  }
  if (format === 'accounts') {
    return formatAccounts(json.accounts ?? []);
  }
  if (format === 'month') {
    return formatMonth(json.report);
  }
  if (format === 'cashflow') {
    return formatCashflow(json.cashflow ?? []);
  }
  if (format === 'transactions') {
    return formatTransactions(json.transactions ?? []);
  }
  if (format === 'budgets') {
    return formatBudgets(json.budgets ?? []);
  }
  if (format === 'query') {
    return formatRows(json.rows ?? []);
  }

  return JSON.stringify(json, null, 2);
}

function formatError(json) {
  const lines = [`Error: ${json.error}`];
  const plaid = json.details?.plaid_error;
  if (plaid) {
    lines.push(`Plaid: ${plaid.error_code} (${plaid.error_type})`);
    if (plaid.request_id) {
      lines.push(`Request ID: ${plaid.request_id}`);
    }
    if (plaid.documentation_url) {
      lines.push(`Docs: ${plaid.documentation_url}`);
    }
  }
  return lines.join('\n');
}

function formatStatus(json) {
  const lines = [
    `Database: ${json.db_path}`,
    `Items: ${json.counts.items}  Accounts: ${json.counts.accounts}  Transactions: ${json.counts.transactions}  Budgets: ${json.counts.budgets}`,
    `Last sync: ${json.counts.last_synced_at ?? 'never'}`
  ];

  for (const item of json.items ?? []) {
    lines.push(`- ${item.institution_name ?? item.item_id} (${item.plaid_env}) cursor=${item.has_cursor ? 'yes' : 'no'}`);
  }

  return lines.join('\n');
}

function formatSync(json) {
  const lines = [
    `Synced ${json.items.length} item(s). Accounts: ${json.totals.accounts}. Added: ${json.totals.added}. Modified: ${json.totals.modified}. Removed: ${json.totals.removed}.`
  ];

  for (const item of json.items) {
    lines.push(`- ${item.institution_name ?? item.item_id}: ${item.accounts} accounts, +${item.added}, ~${item.modified}, -${item.removed}`);
    for (const warning of item.warnings ?? []) {
      const plaid = warning.details?.plaid_error;
      const code = plaid?.error_code ? ` ${plaid.error_code}` : '';
      lines.push(`  Warning:${code} during ${warning.step}. ${warning.message}`);
    }
  }

  return lines.join('\n');
}

function formatAccounts(accounts) {
  if (!accounts.length) {
    return 'No accounts found. Run /sync after linking an institution.';
  }

  return accounts.map((account) => {
    const mask = account.mask ? `...${account.mask}` : 'no mask';
    const balance = money(account.current_balance, account.iso_currency ?? DISPLAY_CURRENCY);
    const available = account.available_balance === null || account.available_balance === undefined
      ? 'n/a'
      : money(account.available_balance, account.iso_currency ?? DISPLAY_CURRENCY);
    return `${account.name} (${account.subtype ?? account.type}, ${mask})  current ${balance}  available ${available}`;
  }).join('\n');
}

function formatMonth(report) {
  if (!report) {
    return 'No month report returned.';
  }

  const lines = [
    `${report.month} spending: ${money(report.totals.spent)}  budgeted: ${money(report.totals.budgeted)}  remaining: ${money(report.totals.remaining)}`
  ];

  if (!report.categories.length) {
    lines.push('No spending found for this month.');
    return lines.join('\n');
  }

  for (const row of report.categories) {
    const budget = row.monthly_limit === null ? 'no budget' : `budget ${money(row.monthly_limit)}, remaining ${money(row.remaining)}`;
    const over = row.over ? ' OVER' : '';
    lines.push(`- ${row.category}: ${money(row.spent)} across ${row.transaction_count} tx (${budget})${over}`);
  }

  return lines.join('\n');
}

function formatCashflow(rows) {
  if (!rows.length) {
    return 'No cashflow rows found.';
  }

  return rows.map((row) => (
    `${row.month}: income ${money(row.income)}  spending ${money(row.spending)}  net ${money(row.net)}`
  )).join('\n');
}

function formatTransactions(transactions) {
  if (!transactions.length) {
    return 'No transactions found for that filter.';
  }

  return transactions.map((tx) => {
    const label = tx.merchant_name || tx.name || 'Unknown';
    const pending = tx.pending ? ' pending' : '';
    return `${tx.date}  ${money(tx.amount, tx.iso_currency ?? DISPLAY_CURRENCY).padStart(12)}  ${tx.category}${pending}  ${label}  [${tx.account_name}]`;
  }).join('\n');
}

function formatBudgets(budgets) {
  if (!budgets.length) {
    return 'No budgets set yet. Use /budget set Dining 400 after choosing categories.';
  }

  return budgets.map((budget) => `${budget.category}: ${money(budget.monthly_limit)}`).join('\n');
}

function formatRows(rows) {
  if (!rows.length) {
    return 'No rows returned.';
  }

  return JSON.stringify(rows, null, 2);
}

async function execute(parsed, rl, { rawJson = false, interactive = false } = {}) {
  if (parsed.type === 'empty') {
    return;
  }
  if (parsed.type === 'exit') {
    return 'exit';
  }
  if (parsed.type === 'help') {
    console.log(HELP.trim());
    return;
  }
  if (parsed.type === 'clear') {
    console.clear();
    return;
  }
  if (parsed.type === 'unknown') {
    console.log(parsed.message);
    return;
  }
  if (parsed.type === 'link') {
    if (!interactive && ['start', 'run', 'open', 'bank', 'banks'].includes(String(parsed.action ?? 'start').toLowerCase())) {
      console.log('Connecting another institution starts a local Plaid Link server.');
      console.log('Run `npm run ethos`, then use `/link start`, or run `node setup-link.js` directly.');
      return;
    }
    console.log(handleLinkCommand(parsed.action));
    return;
  }

  const args = parsed.args;
  if (!args?.length) {
    console.log('No command to run.');
    return;
  }

  if (needsConfirmation(args)) {
    const answer = await rl.question(`This writes to your local DB: node cli.js ${args.join(' ')}\nType yes to continue: `);
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Skipped.');
      return;
    }
  }

  const result = await runCli(args);
  if (rawJson || parsed.type === 'raw-json') {
    console.log(JSON.stringify(result.json, null, 2));
    return;
  }

  console.log(formatResult(result, parsed.format));
}

async function runOnce(text, rawJson) {
  const rl = readline.createInterface({ input, output });
  await execute(parseLine(text), rl, { rawJson, interactive: false });
  rl.close();
}

async function runShell() {
  const statusJson = await loadShellStatus();
  renderBanner(statusJson);
  console.log(`${style('Type', ansi.dim)} ${style('/help', ansi.cyan)} ${style('for commands,', ansi.dim)} ${style('/exit', ansi.cyan)} ${style('to quit.', ansi.dim)}\n`);

  const rl = readline.createInterface({ input, output });
  rl.setPrompt(shellPrompt());
  rl.prompt();

  for await (const line of rl) {
    const result = await execute(parseLine(line), rl, { interactive: true });
    if (result === 'exit') {
      break;
    }
    rl.prompt();
  }

  rl.close();
  stopLinkServer();
}

process.on('exit', () => {
  if (linkServer?.process && !linkServer.process.killed) {
    linkServer.process.kill();
  }
});

const args = process.argv.slice(2);
const onceIndex = args.findIndex((arg) => arg === '--once' || arg === '-c');
const rawJson = args.includes('--json');

if (onceIndex >= 0) {
  const text = args.slice(onceIndex + 1).join(' ');
  await runOnce(text, rawJson);
} else if (args.length) {
  await runOnce(args.filter((arg) => arg !== '--json').join(' '), rawJson);
} else {
  await runShell();
}
