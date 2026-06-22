# Automation

Automation should sync data and produce reports without exposing secrets. Keep logs local and ignored by Git.

## Recommended Scheduled Flow

Daily:

1. Run `node cli.js sync`.
2. Optionally run `node cli.js report month`.
3. Save output to a local log if needed.

Agents can then read fresh cached data without calling Plaid every time.

## Windows Task Scheduler

Run PowerShell as the user who owns the `.env` and DB.

```powershell
$project = "C:\path\to\Ethos"
New-Item -ItemType Directory -Force -Path "$project\logs" | Out-Null

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"Set-Location '$project'; node cli.js sync *> logs\sync.log`""

$trigger = New-ScheduledTaskTrigger -Daily -At 7:00AM

Register-ScheduledTask `
  -TaskName "Ethos Plaid Sync" `
  -Action $action `
  -Trigger $trigger `
  -Description "Sync Ethos Plaid transactions daily" `
  -User $env:USERNAME
```

Run now:

```powershell
Start-ScheduledTask -TaskName "Ethos Plaid Sync"
```

Check:

```powershell
Get-ScheduledTask -TaskName "Ethos Plaid Sync"
Get-Content .\logs\sync.log
```

Remove:

```powershell
Unregister-ScheduledTask -TaskName "Ethos Plaid Sync" -Confirm:$false
```

## Cron

Create a local logs folder:

```bash
mkdir -p /path/to/Ethos/logs
```

Edit crontab:

```bash
crontab -e
```

Daily sync at 7 AM:

```cron
0 7 * * * cd /path/to/Ethos && /usr/bin/env node cli.js sync >> logs/sync.log 2>&1
```

## systemd User Timer

`~/.config/systemd/user/ethos-sync.service`:

```ini
[Unit]
Description=Ethos Plaid sync

[Service]
Type=oneshot
WorkingDirectory=/path/to/Ethos
ExecStart=/usr/bin/env node cli.js sync
StandardOutput=append:/path/to/Ethos/logs/sync.log
StandardError=append:/path/to/Ethos/logs/sync.log
```

`~/.config/systemd/user/ethos-sync.timer`:

```ini
[Unit]
Description=Run Ethos Plaid sync daily

[Timer]
OnCalendar=*-*-* 07:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:

```bash
systemctl --user daemon-reload
systemctl --user enable --now ethos-sync.timer
```

## Scheduled Budget Check

A scheduled job can write a monthly report to a local log:

```bash
node cli.js sync
node cli.js report month
```

For an agent workflow, schedule sync only, then let the agent run reports on demand. This keeps automation simple and avoids noisy notifications.

## Safety For Automations

- Do not run `setup-link.js` on a schedule. It starts an interactive local web server.
- Do not print `.env`.
- Keep logs out of Git.
- Prefer `node cli.js sync` over `npm run sync` inside schedulers if PATH or shell setup is unreliable.
- If `accountsBalanceGet` returns a Plaid warning, sync can still succeed through the fallback accounts endpoint.
