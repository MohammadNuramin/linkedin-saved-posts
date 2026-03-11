/**
 * Sets up a Windows Task Scheduler task that:
 *  - Runs the incremental LinkedIn scraper every day at 8:00 AM
 *  - Runs immediately on next PC startup if the scheduled run was missed
 *    (e.g. PC was off, sleeping, or no network)
 *
 * Run once: node setup-scheduler.js
 * Remove:   node setup-scheduler.js --remove
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';
import os from 'os';

const TASK_NAME = 'LinkedIn Saved Posts Daily Sync';
const SCRIPT_DIR = resolve(import.meta.dirname ?? process.cwd());
const SCRIPT_PATH = join(SCRIPT_DIR, 'sync-and-embed.js');
const NODE_PATH = execSync('where node', { encoding: 'utf8' }).trim().split('\n')[0].trim();

// ─── Remove task ──────────────────────────────────────────────────────────
if (process.argv.includes('--remove')) {
  try {
    execSync(`schtasks /delete /tn "${TASK_NAME}" /f`, { stdio: 'inherit' });
    console.log(`[✓] Task "${TASK_NAME}" removed.`);
  } catch {
    console.log('[!] Task not found or already removed.');
  }
  process.exit(0);
}

// ─── Create task via PowerShell ───────────────────────────────────────────
// We write a temp PS1 file because the command is complex
const runHour   = process.env.SYNC_HOUR   ?? '8';
const runMinute = process.env.SYNC_MINUTE ?? '0';

// PowerShell does not use \ as an escape character in strings — no doubling needed.
// Wrap paths in single quotes inside the PS1 to handle spaces correctly.
const ps1Content = `
$taskName   = '${TASK_NAME}'
$nodePath   = '${NODE_PATH}'
$scriptPath = '${SCRIPT_PATH}'
$workingDir = '${SCRIPT_DIR}'

# Remove existing task if present
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Action: run node sync-and-embed.js (sync + Docker vLLM + embed)
$action = New-ScheduledTaskAction \`
  -Execute   $nodePath \`
  -Argument  """$scriptPath""" \`
  -WorkingDirectory $workingDir

# Trigger: daily at ${runHour.padStart(2,'0')}:${runMinute.padStart(2,'0')}
$trigger = New-ScheduledTaskTrigger -Daily -At '${runHour.padStart(2,'0')}:${runMinute.padStart(2,'0')}'

# Settings:
#   StartWhenAvailable  = run ASAP if PC was off at scheduled time
#   ExecutionTimeLimit  = kill if it runs for more than 1 hour
#   RunOnlyIfNetworkAvailable = need internet for LinkedIn
#   MultipleInstances   = don't start a second instance if one is running
$settings = New-ScheduledTaskSettingsSet \`
  -StartWhenAvailable \`
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) \`
  -RunOnlyIfNetworkAvailable \`
  -MultipleInstances IgnoreNew

# Run as the current logged-in user (interactive, no admin needed)
$principal = New-ScheduledTaskPrincipal \`
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) \`
  -LogonType Interactive \`
  -RunLevel Limited

Register-ScheduledTask \`
  -TaskName  $taskName \`
  -Action    $action \`
  -Trigger   $trigger \`
  -Settings  $settings \`
  -Principal $principal \`
  -Force | Out-Null

Write-Host "[OK] Task registered: $taskName"
Write-Host "[OK] Runs daily at ${runHour.padStart(2,'0')}:${runMinute.padStart(2,'0')}"
Write-Host "[OK] Will catch up on missed runs when PC comes back online"
`;

const tmpPs1 = join(os.tmpdir(), `linkedin-task-setup-${Date.now()}.ps1`);
writeFileSync(tmpPs1, ps1Content, 'utf8');

try {
  console.log('[*] Registering Windows scheduled task...\n');
  const result = execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpPs1}"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  console.log(result);
  console.log(`
┌─────────────────────────────────────────────────────────┐
│  Scheduled task set up successfully!                    │
│                                                         │
│  Name:     ${TASK_NAME.padEnd(45)}│
│  Runs:     Daily at ${String(runHour).padStart(2,'0')}:${String(runMinute).padStart(2,'0')} AM                          │
│  Catch-up: Yes — runs on next startup if PC was off     │
│                                                         │
│  View in:  Task Scheduler → Task Scheduler Library      │
│  Remove:   node setup-scheduler.js --remove             │
│  Test now: node sync-and-embed.js                       │
└─────────────────────────────────────────────────────────┘
`);
} catch (e) {
  const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
  console.error('[error] Failed to create task:', detail || e.message);
  console.error('        If you see "Access Denied", try running as Administrator.');
  process.exit(1);
} finally {
  try { unlinkSync(tmpPs1); } catch { /* ignore */ }
}
