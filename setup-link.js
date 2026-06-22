#!/usr/bin/env node

import express from 'express';
import { listItems, migrate, openDb, upsertItem } from './lib/db.js';
import { COUNTRY_CODES, getInstitutionName, getPlaidClient, PRODUCTS } from './lib/plaid.js';

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

async function exchangeAndStore(client, db, publicToken) {
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

  return {
    item_id: item.item_id,
    institution_name: institutionName
  };
}

async function runSandbox() {
  const db = migrate(openDb());
  const client = getPlaidClient();
  const response = await client.sandboxPublicTokenCreate({
    institution_id: 'ins_109508',
    initial_products: PRODUCTS
  });
  const item = await exchangeAndStore(client, db, response.data.public_token);
  printJson({ ok: true, sandbox: true, item });
}

async function createLinkToken(client) {
  const request = {
    user: {
      client_user_id: 'local-user'
    },
    client_name: 'Plaid Agent',
    products: PRODUCTS,
    country_codes: COUNTRY_CODES,
    language: 'en'
  };

  if (process.env.LINK_REDIRECT_URI) {
    request.redirect_uri = process.env.LINK_REDIRECT_URI;
  }

  const response = await client.linkTokenCreate(request);

  return response.data.link_token;
}

function html() {
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
      ul { padding-left: 20px; }
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
        <button id="fresh" class="secondary">Clear saved Link state</button>
      </div>
      <p>If Plaid is showing only one institution, you are probably on the account-selection step for the institution already chosen. Confirm it, or close Plaid and start a fresh institution search.</p>
      <h2>Linked institutions</h2>
      <ul id="items"><li>Loading...</li></ul>
      <pre id="status"></pre>
    </main>
    <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
    <script>
      const statusEl = document.getElementById('status');
      const button = document.getElementById('link');
      const freshButton = document.getElementById('fresh');
      const itemsEl = document.getElementById('items');

      function show(value) {
        statusEl.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      }

      async function exchange(public_token) {
        show('Exchanging token...');
        const exchangeResponse = await fetch('/exchange_public_token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ public_token })
        });
        const exchangePayload = await exchangeResponse.json();
        if (exchangePayload.ok) {
          localStorage.removeItem('plaid_agent_link_token');
          await loadItems();
        }
        show(exchangePayload);
      }

      function openLink(linkToken, receivedRedirectUri) {
        const config = {
          token: linkToken,
          onSuccess: exchange,
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

          localStorage.setItem('plaid_agent_link_token', tokenPayload.link_token);
          openLink(tokenPayload.link_token);
        } catch (error) {
          show({ ok: false, error: error.message });
        }
      }

      button.addEventListener('click', createAndOpenLink);
      freshButton.addEventListener('click', () => {
        localStorage.removeItem('plaid_agent_link_token');
        history.replaceState(null, '', '/');
        show('Cleared saved Link state. Click "Connect another institution" to start a fresh institution search.');
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
            const name = item.institution_name || item.item_id;
            const synced = item.last_synced_at ? 'last synced ' + item.last_synced_at : 'not synced yet';
            return '<li>' + name + ' (' + item.plaid_env + ', ' + synced + ')</li>';
          }).join('');
        } catch (error) {
          itemsEl.innerHTML = '<li>Could not load linked institutions</li>';
        }
      }

      if (window.location.search.includes('oauth_state_id=')) {
        const linkToken = localStorage.getItem('plaid_agent_link_token');
        if (linkToken) {
          show('Resuming OAuth flow...');
          openLink(linkToken, window.location.href);
        } else {
          show({ ok: false, error: 'Missing saved link token. Restart the Link flow from the home page.' });
        }
      }

      loadItems();
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
    res.type('html').send(html());
  });

  app.get('/oauth-return', (req, res) => {
    res.type('html').send(html());
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
      const linkToken = await createLinkToken(client);
      res.json({ ok: true, link_token: linkToken });
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
      const item = await exchangeAndStore(client, db, publicToken);
      res.json({ ok: true, item });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  const listening = await listen(app, port);
  printJson({
    ok: true,
    url: publicUrl(listening.port),
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
