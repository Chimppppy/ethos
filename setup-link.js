#!/usr/bin/env node

import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  clearItemNeedsUpdate,
  completeLinkSession,
  createLinkSession,
  firstItemForUpdate,
  getItemWithToken,
  latestOpenLinkSession,
  listItems,
  migrate,
  openDb,
  upsertItem
} from './lib/db.js';
import { COUNTRY_CODES, getInstitutionName, getPlaidClient, PRODUCTS, transactionsDaysRequested } from './lib/plaid.js';

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

const LINK_HOST = '127.0.0.1';
const START_IN_UPDATE_MODE = process.argv.includes('--update') || process.argv.includes('--repair');

function optionValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return null;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

const PRESELECTED_ITEM_ID = optionValue('--item');

function publicUrl(port) {
  return `http://${LINK_HOST}:${port}`;
}

function listen(app, requestedPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, attemptsLeft) => {
      const server = app.listen(port, LINK_HOST);

      server.once('listening', () => {
        resolve({
          server,
          port,
          requested_port: requestedPort,
          port_changed: port !== requestedPort
        });
      });

      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
          tryPort(port + 1, attemptsLeft - 1);
          return;
        }
        reject(error);
      });
    };

    tryPort(requestedPort, 20);
  });
}

async function exchangeAndStore(client, db, publicToken, sessionId) {
  const exchangeResponse = await client.itemPublicTokenExchange({
    public_token: publicToken
  });
  const accessToken = exchangeResponse.data.access_token;
  const itemResponse = await client.itemGet({
    access_token: accessToken
  });
  const item = itemResponse.data.item;
  const institutionName = await getInstitutionName(client, item.institution_id);

  upsertItem(db, {
    item_id: item.item_id,
    access_token: accessToken,
    institution_name: institutionName,
    cursor: null,
    last_synced_at: null
  });
  clearItemNeedsUpdate(db, item.item_id);
  if (sessionId) {
    completeLinkSession(db, sessionId);
  }

  return {
    item_id: item.item_id,
    institution_name: institutionName
  };
}

async function runSandbox() {
  const db = migrate(openDb());
  const client = getPlaidClient();
  const daysRequested = transactionsDaysRequested();
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - daysRequested);
  const response = await client.sandboxPublicTokenCreate({
    institution_id: 'ins_109508',
    initial_products: PRODUCTS,
    options: {
      transactions: {
        start_date: startDate.toISOString().slice(0, 10),
        end_date: endDate.toISOString().slice(0, 10)
      }
    }
  });
  const item = await exchangeAndStore(client, db, response.data.public_token);
  printJson({ ok: true, sandbox: true, transactions_days_requested: daysRequested, item });
}

async function createLinkToken(client, db, { mode = 'create', itemId = null } = {}) {
  const daysRequested = transactionsDaysRequested();
  const request = {
    user: {
      client_user_id: 'local-user'
    },
    client_name: 'Ethos Finance',
    country_codes: COUNTRY_CODES,
    language: 'en'
  };

  let item = null;
  if (mode === 'update') {
    item = itemId ? getItemWithToken(db, itemId) : firstItemForUpdate(db);
    if (!item) {
      throw new Error(itemId ? `No local Item found for ${itemId}` : 'No local Item is available to repair');
    }
    request.access_token = item.access_token;
  } else {
    request.products = PRODUCTS;
    request.transactions = {
      days_requested: daysRequested
    };
  }

  if (process.env.LINK_REDIRECT_URI) {
    request.redirect_uri = process.env.LINK_REDIRECT_URI;
  }

  const response = await client.linkTokenCreate(request);
  const session = {
    session_id: randomUUID(),
    mode,
    item_id: item?.item_id ?? null,
    link_token: response.data.link_token
  };
  createLinkSession(db, session);

  return {
    session_id: session.session_id,
    mode,
    item_id: session.item_id,
    institution_name: item?.institution_name ?? null,
    transactions_days_requested: mode === 'create' ? daysRequested : null,
    link_token: response.data.link_token
  };
}

function html({ updateMode = false, itemId = null } = {}) {
  const boot = JSON.stringify({ updateMode, itemId });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Plaid Agent Link</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      main { max-width: 520px; width: 100%; }
      .notice { border-left: 4px solid #f5a623; padding: 10px 12px; background: color-mix(in srgb, #f5a623 12%, transparent); }
      .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0; }
      button { font: inherit; padding: 10px 14px; border-radius: 8px; border: 1px solid currentColor; cursor: pointer; }
      button.secondary { opacity: 0.8; background: transparent; }
      button.repair { border-color: #f5a623; }
      .tag { display: inline-block; margin-left: 6px; padding: 2px 6px; border-radius: 999px; font-size: 12px; background: color-mix(in srgb, #f5a623 18%, transparent); }
      ul { padding-left: 20px; }
      li { margin: 8px 0; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <main>
      <h1>Plaid Agent Link</h1>
      <p>Connect one institution per completed Plaid Link flow. After you finish one bank, start another flow here to connect another bank or card issuer.</p>
      <p class="notice"><strong>If Plaid opens to an already linked bank again:</strong> click <strong>+ Add new account</strong> inside the Plaid modal. Do not click Confirm unless you want to reconnect or change accounts for that bank.</p>
      <div class="actions">
        <button id="link">Connect another institution</button>
        <button id="repair" class="repair">Repair selected connection</button>
        <button id="fresh" class="secondary">Clear saved Link state</button>
      </div>
      <p>If sync reports <code>ITEM_LOGIN_REQUIRED</code>, use repair mode. Ethos will create Plaid Link update mode from the access token stored in your local SQLite database; the token does not live in Claude, Codex, or the terminal session.</p>
      <h2>Linked institutions</h2>
      <ul id="items"><li>Loading...</li></ul>
      <pre id="status"></pre>
    </main>
    <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
    <script>
      const statusEl = document.getElementById('status');
      const button = document.getElementById('link');
      const repairButton = document.getElementById('repair');
      const freshButton = document.getElementById('fresh');
      const itemsEl = document.getElementById('items');
      const boot = ${boot};
      let selectedItemId = boot.itemId;

      function show(value) {
        statusEl.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#039;');
      }

      async function exchange(public_token, sessionId) {
        show('Exchanging token...');
        const exchangeResponse = await fetch('/exchange_public_token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ public_token, session_id: sessionId })
        });
        const exchangePayload = await exchangeResponse.json();
        if (exchangePayload.ok) {
          localStorage.removeItem('ethos_link_session_id');
          await loadItems();
        }
        show(exchangePayload);
      }

      async function finishUpdate(session, metadata) {
        show('Marking connection repaired locally...');
        const response = await fetch('/mark_update_complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            item_id: session.item_id,
            session_id: session.session_id,
            metadata
          })
        });
        const payload = await response.json();
        if (payload.ok) {
          localStorage.removeItem('ethos_link_session_id');
          await loadItems();
        }
        show(payload);
      }

      function openLink(session, receivedRedirectUri) {
        const config = {
          token: session.link_token,
          onSuccess: (publicToken, metadata) => {
            if (session.mode === 'update') {
              finishUpdate(session, metadata);
              return;
            }
            exchange(publicToken, session.session_id);
          },
          onEvent: (eventName, metadata) => {
            if (eventName === 'CONNECT_NEW_INSTITUTION') {
              show('Plaid is switching to institution search...');
            }
            if (eventName === 'SELECT_INSTITUTION' && metadata?.institution_name) {
              show('Selected institution: ' + metadata.institution_name);
            }
          },
          onExit: (err) => {
            if (err) show(err);
          }
        };

        if (receivedRedirectUri) {
          config.receivedRedirectUri = receivedRedirectUri;
        }

        Plaid.create(config).open();
      }

      async function createAndOpenLink() {
        try {
          show('Creating link token...');
          const tokenResponse = await fetch('/create_link_token', { method: 'POST' });
          const tokenPayload = await tokenResponse.json();
          if (!tokenPayload.ok) throw new Error(tokenPayload.error);

          localStorage.setItem('ethos_link_session_id', tokenPayload.session_id);
          openLink(tokenPayload);
        } catch (error) {
          show({ ok: false, error: error.message });
        }
      }

      async function createAndOpenUpdateLink(itemId = selectedItemId) {
        try {
          show('Creating repair link token...');
          const tokenResponse = await fetch('/create_update_link_token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ item_id: itemId || null })
          });
          const tokenPayload = await tokenResponse.json();
          if (!tokenPayload.ok) throw new Error(tokenPayload.error);

          selectedItemId = tokenPayload.item_id;
          localStorage.setItem('ethos_link_session_id', tokenPayload.session_id);
          openLink(tokenPayload);
        } catch (error) {
          show({ ok: false, error: error.message });
        }
      }

      button.addEventListener('click', createAndOpenLink);
      repairButton.addEventListener('click', () => createAndOpenUpdateLink());
      freshButton.addEventListener('click', () => {
        localStorage.removeItem('ethos_link_session_id');
        history.replaceState(null, '', '/');
        show('Cleared browser Link state. Local Plaid access tokens remain in SQLite.');
      });
      itemsEl.addEventListener('click', (event) => {
        const itemId = event.target?.dataset?.repairItemId;
        if (!itemId) return;
        selectedItemId = itemId;
        createAndOpenUpdateLink(itemId);
      });

      async function loadItems() {
        try {
          const response = await fetch('/items');
          const payload = await response.json();
          if (!payload.ok) throw new Error(payload.error);
          if (!payload.items.length) {
            itemsEl.innerHTML = '<li>None yet</li>';
            return;
          }
          itemsEl.innerHTML = payload.items.map((item) => {
            const name = escapeHtml(item.institution_name || item.item_id);
            const synced = item.last_synced_at ? 'last synced ' + escapeHtml(item.last_synced_at) : 'not synced yet';
            const tag = item.needs_update ? '<span class="tag">needs repair</span>' : '';
            const repair = '<button class="secondary" data-repair-item-id="' + escapeHtml(item.item_id) + '">Repair / re-auth</button>';
            return '<li><label><input type="radio" name="item" value="' + escapeHtml(item.item_id) + '"' + (selectedItemId === item.item_id ? ' checked' : '') + '> ' + name + '</label> (' + escapeHtml(item.plaid_env) + ', ' + synced + ') ' + tag + ' ' + repair + '</li>';
          }).join('');
          const radios = itemsEl.querySelectorAll('input[name="item"]');
          radios.forEach((radio) => {
            radio.addEventListener('change', () => {
              selectedItemId = radio.value;
            });
          });
          if (!selectedItemId) {
            const repairCandidate = payload.items.find((item) => item.needs_update) || payload.items[0];
            selectedItemId = repairCandidate?.item_id ?? null;
          }
        } catch (error) {
          itemsEl.innerHTML = '<li>Could not load linked institutions</li>';
        }
      }

      if (window.location.search.includes('oauth_state_id=')) {
        fetch('/latest_link_session')
          .then((response) => response.json())
          .then((payload) => {
            if (!payload.ok) throw new Error(payload.error);
            show('Resuming OAuth flow from local Link session...');
            openLink(payload.session, window.location.href);
          })
          .catch((error) => {
            show({ ok: false, error: 'Missing local Link session. Restart the Link flow from the home page.', details: error.message });
          });
      }

      loadItems().then(() => {
        if (boot.updateMode) {
          show('Repair mode ready. Click "Repair selected connection" to complete Plaid update mode.');
        }
      });
    </script>
  </body>
</html>`;
}

async function runServer() {
  const db = migrate(openDb());
  const client = getPlaidClient();
  const port = Number(process.env.LINK_PORT || 3000);
  const app = express();

  app.use(express.json());

  app.get('/', (req, res) => {
    res.type('html').send(html({
      updateMode: START_IN_UPDATE_MODE,
      itemId: PRESELECTED_ITEM_ID
    }));
  });

  app.get('/oauth-return', (req, res) => {
    res.type('html').send(html({
      updateMode: START_IN_UPDATE_MODE,
      itemId: PRESELECTED_ITEM_ID
    }));
  });

  app.get('/items', (req, res) => {
    try {
      res.json({ ok: true, items: listItems(db) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/create_link_token', async (req, res) => {
    try {
      const session = await createLinkToken(client, db, { mode: 'create' });
      res.json({ ok: true, ...session });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/create_update_link_token', async (req, res) => {
    try {
      const session = await createLinkToken(client, db, {
        mode: 'update',
        itemId: req.body?.item_id || PRESELECTED_ITEM_ID
      });
      res.json({ ok: true, ...session });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/latest_link_session', (req, res) => {
    try {
      const session = latestOpenLinkSession(db);
      if (!session) {
        res.status(404).json({ ok: false, error: 'No open local Link session found' });
        return;
      }
      res.json({ ok: true, session });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/exchange_public_token', async (req, res) => {
    try {
      const publicToken = req.body?.public_token;
      if (!publicToken) {
        res.status(400).json({ ok: false, error: 'public_token is required' });
        return;
      }
      const item = await exchangeAndStore(client, db, publicToken, req.body?.session_id);
      res.json({ ok: true, item });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/mark_update_complete', (req, res) => {
    try {
      const itemId = req.body?.item_id;
      if (!itemId) {
        res.status(400).json({ ok: false, error: 'item_id is required' });
        return;
      }
      clearItemNeedsUpdate(db, itemId);
      if (req.body?.session_id) {
        completeLinkSession(db, req.body.session_id);
      }
      res.json({
        ok: true,
        item_id: itemId,
        message: 'Plaid update mode completed. Run npm run sync to refresh cached data.'
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  const listening = await listen(app, port);
  printJson({
    ok: true,
    url: publicUrl(listening.port),
    mode: START_IN_UPDATE_MODE ? 'update' : 'create',
    transactions_days_requested: START_IN_UPDATE_MODE ? null : transactionsDaysRequested(),
    repair_item_id: PRESELECTED_ITEM_ID,
    port: listening.port,
    requested_port: listening.requested_port,
    port_changed: listening.port_changed
  });
}

async function main() {
  if (process.argv.includes('--sandbox')) {
    await runSandbox();
  } else {
    await runServer();
  }
}

main().catch((error) => {
  printJson({ ok: false, error: error.message });
  process.exitCode = 1;
});
