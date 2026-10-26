/**
 * Real, hidden Tauri/WebView2 handoff fixture. No model, user profile or user
 * browser is involved. Build the debug executable with --features test-harness
 * and start this repository's Vite server separately before running this script.
 *
 * node scripts/test-live-update-smoke.mjs --exe <debug/ccgui-next.exe> \
 *   --url http://localhost:1420 --artifacts <owned-artifact-parent> [--no-rollback]
 *
 * Rollback is enabled by default and uses the REAL 120-second native health
 * deadline. Its only fault injection is the native test-harness-only
 * CCGUI_RUNTIME_FIXTURE_FAIL_HEALTH_RELEASE hook. Nothing is run on import.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageLocal } from './live-update-package.mjs';
import { FixtureRemoteObserver } from './live-update-smoke-remote.mjs';
import { MANAGED_TASK } from './live-update-smoke-mcp.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOT_TIMEOUT = 90_000;
const HANDOFF_TIMEOUT = 180_000;
const ROLLBACK_TIMEOUT = 240_000;
const FIXTURE_LIFETIME_SECONDS = 8 * 60;
const FRAME_PREFIX = 'CCGUI_SMOKE#';
const DRAFT = '保留的未发送草稿 👩‍💻\nThis draft must survive both handoffs.';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const pathKey = value => path.resolve(value).replaceAll('/', '\\').toLowerCase();

class SmokeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function requireThat(condition, code, message) { if (!condition) throw new SmokeError(code, message); }
function event(phase, extra = {}) { console.log(JSON.stringify({ event: 'live-update-smoke', phase, ...extra })); }
function inside(root, filename) {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  requireThat(relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)),
    'fixture-path', 'A generated path escaped the fixture root');
  return filename;
}
function jsonFile(filename, limit = 64 * 1024) {
  try {
    const stat = fs.lstatSync(filename);
    requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'fixture-json', 'Invalid bounded fixture JSON file');
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
function writeNew(filename, value) { fs.writeFileSync(filename, value, { flag: 'wx', mode: 0o600 }); }
function psQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }

export function fixtureEngineConfiguration(fake) {
  // Every installed engine must be pinned to the fixture. Registry PATH lookup
  // can find real CLIs even when the launch environment has an isolated PATH.
  const engines = ['claude', 'kimi', 'grok', 'codex', 'pi', 'omp', 'dsh', 'agy', 'opencode', 'qoder', 'qoder-cn', 'cursor'];
  return {
    bins: Object.fromEntries(engines.map(engine => [`${engine === 'qoder-cn' ? 'qoderCn' : engine}Bin`, fake])),
    config: Object.fromEntries(engines.map(engine => [engine, {
      current: engine === 'claude' ? '__local_settings_json__' : '__disabled__', providers: {},
    }])),
  };
}

export function parseArgs(argv) {
  const result = { rollback: true };
  const names = new Map([['--exe', 'exe'], ['--url', 'url'], ['--resources', 'resources'], ['--artifacts', 'artifacts']]);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') { result.help = true; continue; }
    if (arg === '--managed-child') {
      requireThat(!seen.has('managedChild'), 'arguments', 'Managed child option was repeated');
      seen.add('managedChild'); result.managedChild = true; continue;
    }
    if (arg === '--rollback' || arg === '--no-rollback') {
      requireThat(!seen.has('rollback'), 'arguments', 'Rollback option was repeated');
      seen.add('rollback'); result.rollback = arg === '--rollback';
      if (arg === '--rollback' && ['true', 'false'].includes(argv[i + 1])) result.rollback = argv[++i] === 'true';
      continue;
    }
    const key = names.get(arg);
    requireThat(key && !seen.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--'), 'arguments', 'Unknown, missing or repeated smoke argument');
    seen.add(key); result[key] = argv[++i];
  }
  return result;
}

export function environment(root, profile, failRelease = '') {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  requireThat(systemRoot && path.isAbsolute(systemRoot), 'environment', 'Windows SystemRoot is required');
  const system32 = path.join(systemRoot, 'System32');
  const env = {
    SystemRoot: systemRoot, WINDIR: systemRoot,
    ComSpec: path.join(system32, 'cmd.exe'),
    PATH: [path.join(root, 'bin'), system32, path.join(system32, 'WindowsPowerShell/v1.0')].join(path.delimiter),
    PATHEXT: '.COM;.EXE;.BAT;.CMD;.PS1',
    HOME: root, USERPROFILE: root,
    APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
    TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
    CLAUDE_CONFIG_DIR: path.join(profile, 'engine-home/.claude'), CODEX_HOME: path.join(profile, 'engine-home/.codex'),
    PI_CODING_AGENT_DIR: path.join(profile, 'engine-home/.pi'), OMP_CODING_AGENT_DIR: path.join(profile, 'engine-home/.omp'),
    KIMI_CODE_HOME: path.join(profile, 'engine-home/.kimi-code'), GROK_HOME: path.join(profile, 'engine-home/.grok'),
    CCGUI_RUNTIME_FIXTURE: '1',
    CCGUI_RUNTIME_FIXTURE_FAIL_HEALTH_RELEASE: failRelease,
    CCGUI_RUNTIME_FIXTURE_COMMANDS: '1',
  };
  // OS runtime discovery is allowed; no credentials, user PATH, proxies, shell
  // startup files, engine homes or supervisor configuration are inherited.
  for (const key of ['SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'ALLUSERSPROFILE', 'PROCESSOR_ARCHITECTURE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function fakeClaudeScript(workspace, fallbackSession, mcpHelperPath, managedChild = false) {
  const owned = name => `([IO.Path]::Combine($fixtureOutput,${psQuote(name)}))`;
  return '\uFEFF' + `# Fixture only: no external requests, credentials, tools or model invocation.\r
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)\r
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\r
$utf8 = New-Object Text.UTF8Encoding($false)\r
if ($args -contains '--version') { [Console]::Out.WriteLine('2.1.100 (Claude Code fixture)'); exit 0 }\r
if ($args -contains '--help') { [Console]::Out.WriteLine('Fixture CLI: --session-id --include-partial-messages'); exit 0 }\r
if ($args -notcontains '--input-format' -or $args -notcontains '--output-format') { exit 1 }\r
$session = ${psQuote(fallbackSession)}\r
$explicitSession = $false\r
for ($i = 0; $i -lt $args.Count; $i++) {\r
  if (($args[$i] -eq '--session-id' -or $args[$i] -eq '--resume') -and $i + 1 -lt $args.Count) { $session = [string]$args[$i + 1]; $explicitSession = $true }\r
  if ([string]$args[$i] -like '--session-id=*') { $session = ([string]$args[$i]).Substring(13); $explicitSession = $true }\r
}\r
$initial = [Console]::In.ReadLine()\r
if ($null -eq $initial) { exit 3 }\r
$isManagedChild = ${managedChild ? `$initial.Contains(${psQuote(MANAGED_TASK)})` : '$false'}\r
if ($isManagedChild -and !$explicitSession) { $session = [Guid]::NewGuid().ToString() }\r
$fixtureOutput = ${psQuote(workspace)}\r
if ($isManagedChild) { $fixtureOutput = [IO.Path]::Combine($fixtureOutput,'managed-child') }\r
$record = @{ pid = $PID; startedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress\r
[IO.File]::AppendAllText(${owned('launches.jsonl')}, $record + [Environment]::NewLine, $utf8)\r
[IO.File]::WriteAllText(${owned('fake.pid')}, [string]$PID, $utf8)\r
[Console]::Out.WriteLine((@{ type='system'; subtype='init'; session_id=$session } | ConvertTo-Json -Compress))\r
[Console]::Out.Flush()\r
${mcpHelperPath ? `if (!$isManagedChild) {\r
$mcpConfig=$null\r
for ($i=0; $i -lt $args.Count-1; $i++) { if ($args[$i] -eq '--mcp-config') { $mcpConfig=[string]$args[$i+1] } }\r
if ([string]::IsNullOrWhiteSpace($mcpConfig)) { throw 'Fixture host MCP config is missing' }\r
$mcpStart=New-Object Diagnostics.ProcessStartInfo\r
$mcpStart.FileName=${psQuote(process.execPath)}\r
$mcpStart.Arguments=${psQuote([mcpHelperPath, workspace].map(windowsArgument).join(' '))}\r
$mcpStart.WorkingDirectory=${psQuote(workspace)}\r
$mcpStart.UseShellExecute=$false\r
$mcpStart.CreateNoWindow=$true\r
$mcpStart.RedirectStandardInput=$true\r
$mcpStart.RedirectStandardOutput=$true\r
$mcpStart.RedirectStandardError=$true\r
$mcpHelperProcess=New-Object Diagnostics.Process\r
$mcpHelperProcess.StartInfo=$mcpStart\r
$null=$mcpHelperProcess.Start()\r
$mcpHelperProcess.BeginOutputReadLine()\r
$mcpHelperProcess.BeginErrorReadLine()\r
$mcpHelperProcess.StandardInput.WriteLine($mcpConfig)\r
$mcpHelperProcess.StandardInput.Close()\r
}\r
` : ''}
$sequence = 0\r
$deadline = [DateTime]::UtcNow.AddSeconds(${FIXTURE_LIFETIME_SECONDS})\r
while ([IO.File]::Exists(${owned('keep-running')}) -and [DateTime]::UtcNow -lt $deadline) {\r
  if ($isManagedChild -and [IO.File]::Exists(${owned('pause-before-stop')})) {\r
    [IO.File]::WriteAllText(${owned('paused-for-stop')}, [string]$sequence, $utf8)\r
    while ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }\r
    exit 4\r
  }\r
  $sequence++\r
  $text = '${FRAME_PREFIX}' + $sequence.ToString('D6') + ' 中文🙂' + [char]10\r
  $frame = @{ type='stream_event'; event=@{ type='content_block_delta'; delta=@{ type='text_delta'; text=$text } } }\r
  [Console]::Out.WriteLine(($frame | ConvertTo-Json -Depth 8 -Compress))\r
  [Console]::Out.Flush()\r
  [IO.File]::WriteAllText(${owned('emitted.seq')}, [string]$sequence, $utf8)\r
  Start-Sleep -Milliseconds 150\r
}\r
[Console]::Out.WriteLine((@{ type='result'; subtype='success'; is_error=$false; result=''; session_id=$session; usage=@{ input_tokens=1; output_tokens=$sequence } } | ConvertTo-Json -Depth 8 -Compress))\r
[Console]::Out.Flush()\r
exit 0\r
`;
}

export function processHelperScript() {
  return `param(\n  [ValidateSet('inspect','terminate')][string]$Operation = 'inspect',\n  [Parameter(Mandatory=$true)][string]$Profile,\n  [Parameter(Mandatory=$true)][string]$FakeCli,\n  [int]$TargetPid = 0,\n  [string]$ExpectedExe = '',\n  [long]$ExpectedStarted = 0\n)\n` +
`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
function Owned($item) {
  if ($null -eq $item -or [int]$item.ProcessId -eq $PID) { return $null }
  $command = [string]$item.CommandLine
  if ([string]::IsNullOrWhiteSpace($command) -or [string]::IsNullOrWhiteSpace([string]$item.ExecutablePath)) { return $null }
  $role = $null
  if ($item.Name -ieq 'ccgui-next.exe' -and $command.IndexOf($Profile, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    if ($command.Contains('--task-worker')) { $role='worker' }
    elseif ($command.Contains('--live-update-supervisor')) { $role='supervisor' }
    elseif ($command.Contains('--host-chat-mcp')) { $role='host-mcp' }
    else { $role='host' }
  } elseif ($item.Name -ieq 'powershell.exe' -and $command.IndexOf([IO.Path]::Combine([IO.Path]::GetDirectoryName($PSCommandPath),'watchdog.ps1'), [StringComparison]::OrdinalIgnoreCase) -ge 0) { $role='watchdog' }
  elseif ($item.Name -ieq 'powershell.exe' -and $command.IndexOf($FakeCli, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $command.IndexOf($PSCommandPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) { $role='fake-cli' }
  elseif ($item.Name -ieq 'msedgewebview2.exe' -and $command.IndexOf($Profile, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $role='webview' }
  if ($null -eq $role) { return $null }
  $epoch = [DateTime]::SpecifyKind([DateTime]'1970-01-01', [DateTimeKind]::Utc)
  $started = [long][Math]::Floor(([DateTime]$item.CreationDate).ToUniversalTime().Subtract($epoch).TotalSeconds)
  return @{ pid=[int]$item.ProcessId; role=$role; executable=[string]$item.ExecutablePath; started=$started }
}
if ($Operation -eq 'terminate') {
  if ($TargetPid -le 0 -or $ExpectedStarted -le 0 -or [string]::IsNullOrWhiteSpace($ExpectedExe)) { throw 'Missing exact process identity' }
  $item = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $TargetPid)
  if ($null -eq $item) { [Console]::Out.WriteLine('{"absent":true}'); exit 0 }
  $owned = Owned $item
  if ($null -eq $owned -or $owned.started -ne $ExpectedStarted -or ![string]::Equals($owned.executable,$ExpectedExe,[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture process identity changed; termination refused' }
  $handle = [Diagnostics.Process]::GetProcessById($TargetPid)
  try {
    $null = $handle.Handle
    $epoch = [DateTime]::SpecifyKind([DateTime]'1970-01-01', [DateTimeKind]::Utc)
    $started = [long][Math]::Floor($handle.StartTime.ToUniversalTime().Subtract($epoch).TotalSeconds)
    if ($started -ne $ExpectedStarted -or ![string]::Equals($handle.MainModule.FileName,$ExpectedExe,[StringComparison]::OrdinalIgnoreCase)) { throw 'Held process handle identity changed' }
    $handle.Kill()
    $null = $handle.WaitForExit(5000)
    [Console]::Out.WriteLine('{"terminated":true}')
  } finally { $handle.Dispose() }
  exit 0
}
$items = @(Get-CimInstance Win32_Process -Filter "Name='ccgui-next.exe' OR Name='powershell.exe' OR Name='msedgewebview2.exe'" | ForEach-Object { $owned = Owned $_; if ($null -ne $owned) { $owned } })
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $items -Depth 4 -Compress))
`;
}

export function watchdogScript() {
  return `param([int]$ControllerPid,[string]$ControllerExe,[string]$Root,[string]$Profile,[string]$FakeCli,[string]$Helper,[int]$LifetimeSeconds=480)
$ErrorActionPreference='Stop'
$cancel=[IO.Path]::Combine($Root,'watchdog.cancel')
$deadline=[DateTime]::UtcNow.AddSeconds($LifetimeSeconds)
$powershell=[IO.Path]::Combine($env:SystemRoot,'System32\\WindowsPowerShell\\v1.0\\powershell.exe')
$controller=$null
try {
  try {
    $controller=[Diagnostics.Process]::GetProcessById($ControllerPid)
    $null=$controller.Handle
    if (![string]::Equals($controller.MainModule.FileName,$ControllerExe,[StringComparison]::OrdinalIgnoreCase)) { throw 'Controller identity differs' }
  } catch { throw 'Cannot hold the exact fixture controller process' }
  [IO.File]::WriteAllText([IO.Path]::Combine($Root,'watchdog.ready.json'), (@{pid=$PID;controller=$ControllerPid} | ConvertTo-Json -Compress))
  while (![IO.File]::Exists($cancel) -and [DateTime]::UtcNow -lt $deadline -and $null -ne $controller -and !$controller.HasExited) { Start-Sleep -Milliseconds 500 }
  if ([IO.File]::Exists($cancel)) { exit 0 }
  $reason=if ([DateTime]::UtcNow -ge $deadline) {'lifetime'} else {'controller-exit'}
  [IO.File]::WriteAllText([IO.Path]::Combine($Root,'watchdog.fired.json'), (@{reason=$reason;at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress))
  $marker=[IO.Path]::Combine($Root,'workspace\\keep-running')
  if ([IO.File]::Exists($marker)) { [IO.File]::Delete($marker) }
  # Only the same bounded identity verifier used by ordinary fixture cleanup.
  $failures=@()
  foreach ($role in @('supervisor','worker','host-mcp','host','fake-cli','webview')) {
    $raw=& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Helper -Operation inspect -Profile $Profile -FakeCli $FakeCli
    if ($LASTEXITCODE -ne 0) { $failures+=@{role=$role;stage='inventory';exitCode=$LASTEXITCODE}; continue }
    # PS 5.1 emits a JSON array as ONE pipeline object. Parenthesize the
    # conversion so each iteration has one identity, including the empty case.
    $items=@((ConvertFrom-Json -InputObject $raw))
    foreach ($item in $items) {
      if ($item.role -eq $role -and $item.pid -ne $PID) {
        try {
          $detail=(& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Helper -Operation terminate -Profile $Profile -FakeCli $FakeCli -TargetPid $item.pid -ExpectedExe $item.executable -ExpectedStarted $item.started 2>&1 | Out-String)
          if ($LASTEXITCODE -ne 0) { $failures+=@{role=$role;pid=$item.pid;executable=$item.executable;started=$item.started;exitCode=$LASTEXITCODE;detail=$detail.Substring(0,[Math]::Min(1200,$detail.Length))} }
        } catch { $failures+=@{role=$role;pid=$item.pid;executable=$item.executable;started=$item.started;detail=$_.Exception.Message} }
      }
    }
  }
  $raw=& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Helper -Operation inspect -Profile $Profile -FakeCli $FakeCli
  if ($LASTEXITCODE -ne 0) { throw 'Watchdog final process inventory failed' }
  $remaining=@((ConvertFrom-Json -InputObject $raw) | Where-Object { $_.pid -ne $PID })
  [IO.File]::WriteAllText([IO.Path]::Combine($Root,'watchdog.cleanup.json'), (@{failures=$failures;remaining=$remaining} | ConvertTo-Json -Depth 6 -Compress))
  if ($failures.Count -gt 0 -or $remaining.Count -gt 0) { throw 'Watchdog cleanup incomplete; inspect watchdog.cleanup.json' }
} catch {
  [IO.File]::WriteAllText([IO.Path]::Combine($Root,'watchdog.error.json'), (@{message=$_.Exception.Message} | ConvertTo-Json -Compress))
  exit 1
} finally { if ($null -ne $controller) { $controller.Dispose() } }
`;
}

function windowsArgument(value) {
  return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"';
}

// Node's detached flag uses DETACHED_PROCESS: Windows PowerShell can exit
// successfully without executing its script in that mode. Explicit breakaway
// also keeps this bounded guard alive if the controller's enclosing Job closes.
export function watchdogLauncherScript(executable, args, cwd) {
  const command = [executable, ...args].map(windowsArgument).join(' ');
  return `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FixtureGuardLauncher {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Startup { public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,reservedSize; public IntPtr reservedData,input,output,error; }
  [StructLayout(LayoutKind.Sequential)]
  public struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CreateProcessW(string exe,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo result);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$startup=New-Object FixtureGuardLauncher+Startup
$startup.cb=[Runtime.InteropServices.Marshal]::SizeOf($startup)
$result=New-Object FixtureGuardLauncher+ProcessInfo
$command=New-Object Text.StringBuilder(${psQuote(command)})
if (![FixtureGuardLauncher]::CreateProcessW(${psQuote(executable)},$command,[IntPtr]::Zero,[IntPtr]::Zero,$false,0x09000000,[IntPtr]::Zero,${psQuote(cwd)},[ref]$startup,[ref]$result)) { throw ('CreateProcessW guard failed: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
try { [Console]::Out.WriteLine((@{pid=$result.pid} | ConvertTo-Json -Compress)) }
finally { $null=[FixtureGuardLauncher]::CloseHandle($result.thread); $null=[FixtureGuardLauncher]::CloseHandle($result.process) }
`;
}

export async function childOutput(executable, args, { env, cwd, timeout = 15_000 } = {}) {
  const child = spawn(executable, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return await new Promise((resolve, reject) => {
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => { child.kill(); finish(new SmokeError('helper-timeout', 'A fixture-owned helper exceeded its deadline')); }, timeout);
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.on('error', () => finish(new SmokeError('helper-spawn', 'A fixture helper could not be started')));
    child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); if (stdout.length > 2 * 1024 * 1024) { child.kill(); finish(new SmokeError('helper-output', 'Fixture helper output exceeded its bound')); } });
    child.stderr.on('data', bytes => { if (stderr.length < 8192) stderr += bytes.toString('utf8'); });
    child.on('exit', code => finish(null, { code, stdout, stderr }));
  });
}

export class FixturePage {
  constructor(directory) { this.directory = directory; this.closed = false; }
  async evaluate(expression, timeout = 30_000) {
    requireThat(!this.closed, 'fixture-page-closed', 'Fixture page connection is closed');
    // Vite attaches ?t= to modules changed during a long-lived dev-server run.
    // Importing the bare URL would create a second store/checkpoint registry.
    const rewritten = expression.replace(/\bimport\((['"])(\/src\/[^'"]+)\1\)/g, 'fixtureImport($1$2$1)');
    expression = `(async()=>{
      const fixtureImport=async(modulePath)=>{
        const loaded=[...performance.getEntriesByType('resource')].reverse().find(entry=>{
          try{return new URL(entry.name).pathname===modulePath;}catch{return false;}
        });
        if(loaded)return import(loaded.name);
        const parents={'/src/features/chat/store.ts':'/src/bootstrap.tsx','/src/lib/transport.ts':'/src/lib/live-update-bootstrap.ts'};
        if(parents[modulePath]){
          const source=await (await fetch(parents[modulePath])).text();
          const urls=[...source.matchAll(/from\\s+["']([^"']+)["']/g)].map(match=>match[1]);
          const resolved=urls.find(value=>new URL(value,location.href).pathname===modulePath);
          if(!resolved)throw new Error('Fixture could not resolve the loaded application module');
          return import(resolved);
        }
        return import(modulePath);
      };
      return await (${rewritten});
    })()`;
    const id = randomUUID();
    const request = JSON.stringify({ id, expression });
    requireThat(Buffer.byteLength(request) <= 512 * 1024, 'fixture-evaluation-size', 'Fixture expression exceeds its bound');
    const temporary = path.join(this.directory, 'inbox', `${id}.tmp`);
    writeNew(temporary, request);
    fs.renameSync(temporary, path.join(this.directory, 'inbox', `${id}.json`));
    const responsePath = path.join(this.directory, 'outbox', `${id}.json`);
    const started = Date.now();
    while (Date.now() - started < timeout) {
      requireThat(!this.closed, 'fixture-page-closed', 'Fixture page connection is closed');
      const result = jsonFile(responsePath, 8 * 1024 * 1024);
      if (result) {
        fs.unlinkSync(responsePath);
        requireThat(!result.error, 'frontend-evaluation', `Fixture frontend evaluation rejected: ${String(result.error).slice(0, 500)}`);
        return result.value;
      }
      await delay(30);
    }
    throw new SmokeError('fixture-page-timeout', 'Fixture frontend evaluation timed out');
  }
  close() { this.closed = true; }
}

function frames(text) {
  const items = [...text.matchAll(/CCGUI_SMOKE#(\d{6}) 中文🙂\n/g)].map(match => Number(match[1]));
  requireThat(items.length > 0 && items.every((number, index) => number === index + 1), 'stream-sequence', 'GUI text contains a missing, reordered or duplicate fake-CLI frame');
  const exact = items.map(number => `${FRAME_PREFIX}${String(number).padStart(6, '0')} 中文🙂\n`).join('');
  requireThat(text === exact, 'stream-content', 'GUI assistant text differs from the exact Chinese/emoji fixture payload');
  return items.length;
}

export async function runSmoke(options) {
  requireThat(process.platform === 'win32', 'platform', 'This smoke fixture currently requires Windows WebView2');
  requireThat(typeof WebSocket === 'function' && typeof fetch === 'function', 'node-version', 'Use Node with built-in fetch and WebSocket (Node 22 or later)');
  requireThat(options.exe && options.url, 'arguments', '--exe and --url are required');
  const executable = fs.realpathSync.native(path.resolve(options.exe));
  requireThat(fs.statSync(executable).isFile(), 'executable', 'The explicit cargo-built executable is not a file');
  const vite = new URL(options.url);
  requireThat(vite.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(vite.hostname)
    && !vite.username && !vite.password && !vite.search && !vite.hash && vite.pathname === '/', 'frontend-url', 'Use a plain loopback Vite origin');
  const tauriConfig = JSON.parse(fs.readFileSync(path.join(PROJECT, 'src-tauri/tauri.conf.json'), 'utf8'));
  requireThat(vite.port === new URL(tauriConfig.build.devUrl).port, 'frontend-url', 'The provided Vite port differs from the debug Tauri devUrl');
  const resources = fs.realpathSync.native(path.resolve(options.resources ?? path.join(PROJECT, 'src-tauri/resources')));
  const artifactParent = path.resolve(options.artifacts ?? path.join(PROJECT, '.artifacts/live-update-smoke'));
  fs.mkdirSync(artifactParent, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(artifactParent, 'run-')));
  const profile = path.join(root, 'profile');
  const workspace = path.join(root, 'workspace');
  const taskOutput = options.managedChild ? path.join(workspace, 'managed-child') : workspace;
  const successorWorkspace = path.join(root, 'successor-workspace');
  const fake = path.join(root, 'bin/claude.ps1');
  const successorFake = path.join(root, 'bin/successor-claude.ps1');
  const helper = path.join(root, 'process-helper.ps1');
  const mcpHelper = path.join(root, 'bin/self-update-mcp.mjs');
  const watchdogPath = path.join(root, 'watchdog.ps1');
  const reportPath = path.join(root, 'report.json');
  const suffix = randomUUID();
  const goodRelease = `smoke-good-${suffix}`;
  const badRelease = `smoke-bad-${suffix}`;
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), fixtureRoot: root,
    inputs: { executable, resources, frontendUrl: vite.origin, rollbackRequested: options.rollback !== false, managedChild: !!options.managedChild, packageMode: 'working-tree' },
    fixtureLifetimeSeconds: FIXTURE_LIFETIME_SECONDS, results: [], status: 'running', cleanup: { complete: false } };
  const abort = new AbortController();
  const connections = new Set();
  let phase = 'setup'; let initialChild; let watchdog; let ownedProfileConfirmed = false; let ps; let env;
  let workerBefore; let currentPage; let initialHost; let goodPackage; let badPackage; let remote; let webIdentity;
  let managedBranch; let parentSessionId; let parentWorkerBefore;
  const signal = () => { abort.abort(); for (const connection of connections) connection.close(); };
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  const saveReport = () => fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const wait = async (label, timeout, inspect, interval = 250) => {
    const started = Date.now(); let progress = started;
    while (Date.now() - started < timeout) {
      if (abort.signal.aborted) throw new SmokeError('interrupted', 'Smoke fixture was interrupted');
      if (fs.existsSync(path.join(root, 'watchdog.fired.json'))) throw new SmokeError('fixture-lifetime', 'The independent fixture lifetime guard fired');
      const mcpError = jsonFile(path.join(workspace, 'self-update-mcp-error.json'));
      if (mcpError) throw new SmokeError('fixture-mcp', `Fixture MCP helper failed: ${mcpError.error}`);
      const value = await inspect(); if (value) return value;
      if (Date.now() - progress >= 15_000) { event(phase, { waitingFor: label, elapsedMs: Date.now() - started }); progress = Date.now(); }
      await delay(interval);
    }
    throw new SmokeError('deadline', `Timed out waiting for ${label}`);
  };
  const processCommand = async (operation = 'inspect', record) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-Operation', operation, '-Profile', profile, '-FakeCli', fake];
    if (record) args.push('-TargetPid', String(record.pid), '-ExpectedExe', record.executable, '-ExpectedStarted', String(record.started));
    const result = await childOutput(ps, args, { env, cwd: root });
    requireThat(result.code === 0, 'process-identity', 'Fixture process identity helper failed; no unverified process will be stopped');
    try { return JSON.parse(result.stdout.trim()); } catch { throw new SmokeError('process-identity', 'Fixture process helper returned invalid metadata'); }
  };
  const inventory = async () => {
    const items = await processCommand();
    requireThat(Array.isArray(items), 'process-identity', 'Fixture process inventory was not an array');
    return items;
  };
  const readUpdate = () => jsonFile(path.join(profile, 'runtime-updates/state.json'));
  const manifests = () => {
    const directory = path.join(profile, 'runtime/task-workers');
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
      const manifest = jsonFile(inside(root, path.join(directory, entry.name, 'manifest.json')));
      if (!manifest) return [];
      requireThat(pathKey(manifest.profile) === pathKey(profile) && manifest.workerId === entry.name, 'worker-profile', 'Worker manifest does not belong to this fixture');
      return [manifest];
    });
  };
  const fakePid = () => {
    try { const value = Number(fs.readFileSync(path.join(taskOutput, 'fake.pid'), 'utf8').trim()); return Number.isInteger(value) && value > 0 ? value : null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const launches = () => {
    try { return fs.readFileSync(path.join(taskOutput, 'launches.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const assertProcesses = async expected => {
    const all = await inventory();
    const worker = all.find(item => item.pid === expected.workerPid && item.role === 'worker');
    const native = all.find(item => item.pid === expected.fakePid && item.role === 'fake-cli');
    requireThat(worker && worker.started === expected.workerStarted && pathKey(worker.executable) === pathKey(expected.workerExecutable),
      'worker-replaced', 'The original worker process did not survive the handoff');
    requireThat(native && native.started === expected.fakeStarted, 'cli-replaced', 'The original fake CLI process did not survive the handoff');
    requireThat(launches().length === 1, 'duplicate-launch', 'The fake CLI was launched more than once');
  };
  const ownPage = async (expectedExe, excludedPids = new Set(), timeout = BOOT_TIMEOUT) => wait('owned WebView2 target', timeout, async () => {
    if (phase === 'successful-handoff') {
      const transaction = readUpdate()?.transaction;
      requireThat(!['Failed', 'RolledBack'].includes(transaction?.phase), 'unexpected-rollback',
        `Healthy candidate activation failed: ${transaction?.failureReason ?? 'unknown'}`);
    }
    if (phase === 'candidate-health-rollback') {
      const transaction = readUpdate()?.transaction;
      requireThat(transaction?.phase !== 'Failed' || transaction.failureReason === 'CandidateHealthTimeout',
        'candidate-not-started', 'Second self-update failed before its health-timeout scenario');
    }
    const hosts = (await inventory()).filter(item => item.role === 'host' && !excludedPids.has(item.pid));
    const matching = hosts.filter(item => pathKey(item.executable) === pathKey(expectedExe));
    requireThat(matching.length <= 1, 'multiple-hosts', 'More than one matching fixture GUI host is running');
    if (!matching.length) return null;
    const bridgeDirectory = path.join(profile, 'runtime-fixture-bridge', String(matching[0].pid));
    const ready = jsonFile(path.join(bridgeDirectory, 'ready.json'));
    if (ready?.pid !== matching[0].pid || ready.bridgeVersion !== 1) return null;
      let connection;
      try {
        connection = new FixturePage(bridgeDirectory); connections.add(connection);
        const owned = await connection.evaluate(`(async()=>{
          performance.setResourceTimingBufferSize(10000);
          if (!window.__TAURI_INTERNALS__?.invoke) return false;
          const native=(command,args)=>window.__TAURI_INTERNALS__.invoke(command,args);
          if (!await native('development_profile_active')) return false;
          const settings=await native('get_app_settings');
          return settings.claudeBin===${JSON.stringify(fake)} && settings.autoTitleEnabled===false;
        })()`, 5000);
        if (!owned) { connection.close(); connections.delete(connection); return null; }
        // Importing a store before main.tsx installs its recovery checkpoint
        // would itself break initialization. React mounts only AFTER that cut.
        await wait('fixture React mount', 30_000, async () => connection.evaluate(
          "document.documentElement.dataset.appMounted === '1'", 3000));
        // A fresh profile opens the real feature guide. Dismiss it through its
        // normal control; never remove the open-dialog readiness protection.
        const tourOpen = await connection.evaluate(`(async()=>{
          const {useOnboardingStore}=await import('/src/features/onboarding/store.ts');
          useOnboardingStore.getState().autoStartIfFirstInstall();
          return useOnboardingStore.getState().open;
        })()`);
        if (tourOpen) await wait('fixture guide dismissal', 10_000, async () => connection.evaluate(`(async()=>{
          document.querySelector('[data-testid="onboarding-close-button"]')?.click();
          const {useOnboardingStore}=await import('/src/features/onboarding/store.ts');
          return !useOnboardingStore.getState().open && !document.querySelector('[data-testid="onboarding-tour-overlay"]');
        })()`));
        ownedProfileConfirmed = true;
        return { connection, host: matching[0] };
      } catch (error) {
        if (connection && !connection.closed) {
          try {
            report.bootDiagnostics = await connection.evaluate(`({
              location:location.origin+location.pathname,
              readyState:document.readyState,
              mounted:document.documentElement.dataset.appMounted ?? null,
              bodyText:(document.body?.innerText ?? '').slice(0,4000),
              scripts:[...document.scripts].map(script=>script.src).slice(0,12)
            })`, 3000);
          } catch { /* The original startup failure remains authoritative. */ }
        }
        connection?.close(); if (connection) connections.delete(connection);
        if (error instanceof SmokeError && error.code === 'frontend-evaluation') throw error;
      }
    return null;
  }, 400);
  const snapshot = async page => page.connection.evaluate(`(async()=>{
    const chat=await import('/src/features/chat/store.ts');
    const transport=await import('/src/lib/transport.ts');
    const state=chat.useChatStore.getState();
    const active=state.active;
    if (!active || active.workspacePath!==${JSON.stringify(workspace)}) return {ready:false,inert:document.documentElement.inert};
    const key=chat.sessionKey(active.engine,active.sessionId,active.workspacePath);
    const session=state.bySession[key];
    const text=(session?.messages??[]).filter(message=>message.role==='assistant').map(message=>message.text??'').join('');
    const draft=state.drafts[key]??'';
    const editors=[...document.querySelectorAll('textarea,[contenteditable="true"]')];
    const normalize=value=>String(value??'').replaceAll('\\r\\n','\\n').replace(/\\n$/,'');
    const draftVisible=editors.some(element=>[element.value,element.innerText,element.textContent].some(value=>normalize(value)===normalize(draft)));
    const sources=await window.__TAURI_INTERNALS__.invoke('runtime_worker_sources');
    return {ready:!!session,sessionId:active.sessionId,key,runId:session?.nativeTaskRunId??null,
      streaming:session?.streaming??false,error:session?.error??null,text,draft,draftVisible,
      renderedFramePresent:document.body.innerText.includes(${JSON.stringify(FRAME_PREFIX)}),
      renderedFrameInDom:document.body.textContent.includes(${JSON.stringify(FRAME_PREFIX)}),editorCount:editors.length,
      visibleState:document.visibilityState,viewport:[innerWidth,innerHeight],
      draftEditorLengths:editors.map(element=>[element.value,element.innerText,element.textContent].map(value=>String(value??'').length)),
      pageTextPrefix:document.body.innerText.slice(0,1600),
      inert:document.documentElement.inert,cursors:transport.getWorkerEventCursors(),sources};
  })()`);
  const readySnapshot = async (page, afterCount = 0) => wait('restored draft and progressing exact GUI text', 45_000, async () => {
    const value = await snapshot(page);
    report.lastReadiness = { ready: value.ready, inert: value.inert, textChars: value.text?.length,
      correctDraft: value.draft === DRAFT, draftVisible: value.draftVisible, editorCount: value.editorCount,
      renderedFramePresent: value.renderedFramePresent, renderedFrameInDom: value.renderedFrameInDom,
      visibleState: value.visibleState, viewport: value.viewport, draftEditorLengths: value.draftEditorLengths,
      pageTextPrefix: value.pageTextPrefix };
    if (!value.ready || value.inert || !value.text || value.draft !== DRAFT || !value.draftVisible || !value.renderedFramePresent) return null;
    const count = frames(value.text);
    return count > afterCount ? { ...value, frameCount: count } : null;
  });
  const summarize = (page, state) => ({ hostPid: page.host.pid, sessionId: state.sessionId, frameCount: state.frameCount,
    textSha256: sha256(state.text), draftSha256: sha256(state.draft), draftVisible: state.draftVisible,
    renderedFramePresent: state.renderedFramePresent, inert: state.inert,
    workerCursor: workerBefore ? state.cursors[workerBefore.workerId] : undefined,
    workerPid: workerBefore?.workerPid, fakePid: workerBefore?.fakePid, fakeLaunches: launches().length });
  const assertRemote = async (page, minimumHellos, prefix) => {
    const identity = await page.connection.evaluate("window.__TAURI_INTERNALS__.invoke('web_access_status')");
    requireThat(identity?.port === webIdentity.port && identity?.token === webIdentity.token,
      'remote-identity', 'Restored local WebSocket service changed its port or credential');
    await remote.sync();
    requireThat(!remote.error && remote.summary.helloCount >= minimumHellos,
      'remote-reconnect', 'The original remote client did not reconnect automatically');
    requireThat(remote.text.startsWith(prefix), 'remote-prefix', 'Remote replay lost or changed the existing stream prefix');
    frames(remote.text);
    return { ...remote.summary, sameServiceIdentity: true, textSha256: sha256(remote.text) };
  };
  const mcpReceipt = async (id, timeout = 60_000) => wait('originating task MCP result', timeout, async () => {
    const reply = jsonFile(path.join(workspace, `self-update-receipt-${id}.json`), 2 * 1024 * 1024);
    if (!reply) return null;
    requireThat(!reply.error && !reply.isError, 'mcp-tool-result', `Fixture MCP call failed: ${reply.error ?? 'tool returned an error'}`);
    const content = reply.content?.find(item => item.type === 'text' && typeof item.text === 'string')?.text;
    requireThat(content, 'mcp-tool-result', 'Fixture MCP result omitted structured text');
    try { return JSON.parse(content); } catch { throw new SmokeError('mcp-tool-result', 'Fixture MCP result was not JSON'); }
  });
  const writeMcpCommand = command => {
    const temporary = path.join(workspace, `self-update-command-${randomUUID()}.tmp`);
    writeNew(temporary, JSON.stringify(command));
    fs.renameSync(temporary, path.join(workspace, 'self-update-command.json'));
  };
  const branchSnapshot = async () => currentPage.connection.evaluate("window.__TAURI_INTERNALS__.invoke('task_snapshot', {})");
  const assertManagedBranch = async (expectedState) => {
    if (!options.managedChild) return;
    return wait('restored managed branch identity', 30_000, async () => {
      const branch = (await branchSnapshot()).branches?.find(item => item.id === managedBranch.id);
      if (!branch || (expectedState && branch.state !== expectedState)) return null;
      requireThat(branch.runId === managedBranch.runId && branch.sessionId === managedBranch.sessionId
        && branch.parentSessionId === parentSessionId && branch.parentEngine === 'claude'
        && branch.engine === 'claude' && branch.workspacePath === workspace,
      'managed-identity', 'Managed child identity or parent relationship changed across handoff');
      const parentWorker = manifests().find(item => item.runId === parentWorkerBefore.runId);
      requireThat(parentWorker?.pid === parentWorkerBefore.pid && parentWorker.processStartTime === parentWorkerBefore.processStartTime,
        'managed-parent-worker', 'The parent worker identity changed across handoff');
      requireThat(fs.readFileSync(path.join(workspace, 'launches.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).length === 1,
        'duplicate-parent', 'Parent CLI was relaunched across handoff');
      return branch;
    });
  };
  const updateDiagnostic = async page => page.connection.evaluate(`(async()=>{
    const {useLiveUpdateStore}=await import('/src/features/update/live-update.ts');
    const {getRuntimeCheckpointReadiness}=await import('/src/lib/runtime-checkpoint.ts');
    const s=useLiveUpdateStore.getState();
    return {support:s.support,stage:s.stage,error:s.error,errorCode:s.errorCode,blockers:s.blockers,readiness:getRuntimeCheckpointReadiness()};
  })()`, 3000);
  const stage = async (_page, bundle, id) => {
    // Only the fake CLI's persistent MCP client initiates the update. The test
    // controller never invokes stage/activate or installs an extra UI watcher.
    report.updateDiagnostics ??= [];
    try { report.updateDiagnostics.push({ at:'before-stage', state:await updateDiagnostic(_page) }); saveReport(); } catch {}
    writeMcpCommand({ id,
      packageDir: bundle.output, manifestSha256: bundle.manifestSha256 });
    const transaction = await wait('staged production transaction', 30_000, async () => {
      const state = readUpdate();
      return state?.transaction?.candidate?.manifestSha256 === bundle.manifestSha256 ? state.transaction : null;
    });
    try { report.updateDiagnostics.push({ at:'after-stage', state:await updateDiagnostic(_page) }); saveReport(); } catch {}
    return transaction;
  };
  const privateShutdown = async manifest => {
    const matches = (await inventory()).find(item => item.role === 'worker' && item.pid === manifest.pid
      && item.started === manifest.processStartTime && pathKey(item.executable) === pathKey(manifest.executable));
    if (!matches) return;
    await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port: manifest.port });
      const timer = setTimeout(() => { socket.destroy(); resolve(); }, 1500);
      const done = () => { clearTimeout(timer); socket.destroy(); resolve(); };
      socket.once('connect', () => socket.write(`${JSON.stringify({ protocol: manifest.protocol, workerId: manifest.workerId,
        token: manifest.token, id: `smoke-stop-${randomUUID()}`, command: { op: 'shutdown' } })}\n`));
      socket.once('data', done); socket.once('error', done); socket.once('close', done);
    });
  };

  try {
    for (const directory of ['bin', 'appdata', 'localappdata', 'tmp', 'workspace/.claude', 'successor-workspace/.claude', 'profile/webview-data',
      'profile/engine-home/.claude', 'profile/engine-home/.codex', 'profile/engine-home/.pi', 'profile/engine-home/.omp', 'profile/engine-home/.kimi-code', 'profile/engine-home/.grok', 'profile/engine-home/.cursor']) {
      fs.mkdirSync(inside(root, path.join(root, directory)), { recursive: true });
    }
    env = environment(root, profile, badRelease);
    ps = path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    writeNew(helper, processHelperScript());
    writeNew(watchdogPath, watchdogScript());
    writeNew(mcpHelper, fs.readFileSync(path.join(PROJECT, 'scripts/live-update-smoke-mcp.mjs')));
    if (options.managedChild) fs.mkdirSync(taskOutput);
    writeNew(fake, fakeClaudeScript(workspace, randomUUID(), mcpHelper, !!options.managedChild));
    writeNew(successorFake, fakeClaudeScript(successorWorkspace, randomUUID()));
    writeNew(path.join(workspace, 'keep-running'), 'owned fixture lifetime\n');
    if (options.managedChild) writeNew(path.join(taskOutput, 'keep-running'), 'owned managed child; cancel through task_stop\n');
    writeNew(path.join(workspace, '.claude/settings.local.json'), JSON.stringify({ env: { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } }));
    const { bins: fixtureBins, config } = fixtureEngineConfiguration(fake);
    writeNew(path.join(profile, 'settings.json'), JSON.stringify({ ...fixtureBins, autoTitleEnabled: false,
      defaultClaudeUltracode: false, codexDesktopHandoffEnabled: false, dshAutoStart: false,
      webRelayOn: false, systemProxyEnabled: false, petEnabled: false, language: 'en' }));
    writeNew(path.join(profile, 'config.json'), JSON.stringify(config));
    saveReport();
    event(phase, { fixtureRoot: root, pageBridge: 'test-harness-files', rollbackRequested: options.rollback !== false });
    const viteResponse = await fetch(new URL('/src/features/chat/store.ts', vite), { signal: AbortSignal.timeout(5000) });
    requireThat(viteResponse.ok && (await viteResponse.text()).includes('useChatStore'), 'vite-unavailable', 'The explicit Vite server is not serving this project store');
    phase = 'probe-and-package';
    const probeResult = await childOutput(executable, ['--task-worker-probe', '--dev-profile', profile], { env, cwd: root });
    requireThat(probeResult.code === 0, 'worker-probe', 'Candidate worker compatibility probe failed');
    let probe;
    try { probe = JSON.parse(probeResult.stdout.trim()); } catch { throw new SmokeError('worker-probe', 'Worker compatibility probe was not valid JSON'); }
    requireThat(probe.protocol === 1 && /^[a-f0-9]{64}$/.test(probe.schemaHash), 'worker-probe', 'Worker protocol or schema hash is incompatible');
    report.probe = { protocol: probe.protocol, schemaHash: probe.schemaHash };
    const common = { exe: executable, resources, version: tauriConfig.version, schemaHash: probe.schemaHash, mode: 'working-tree' };
    const baseline = packageLocal({ ...common, output: path.join(root, 'baseline'), releaseId: `smoke-baseline-${suffix}` });
    goodPackage = packageLocal({ ...common, output: path.join(root, 'good-package'), releaseId: goodRelease });
    if (options.rollback !== false) badPackage = packageLocal({ ...common, output: path.join(root, 'bad-package'), releaseId: badRelease });
    const baselineExe = path.join(baseline.output, 'ccgui-next.exe');
    const watchdogArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', watchdogPath,
      '-ControllerPid', String(process.pid), '-ControllerExe', process.execPath, '-Root', root,
      '-Profile', profile, '-FakeCli', fake, '-Helper', helper, '-LifetimeSeconds', String(FIXTURE_LIFETIME_SECONDS)];
    const launcher = inside(root, path.join(root, 'launch-watchdog.ps1'));
    writeNew(launcher, watchdogLauncherScript(ps, watchdogArgs, root));
    const launchedGuard = await childOutput(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher], { env, cwd: root });
    requireThat(launchedGuard.code === 0, 'watchdog-spawn', `Independent guard launch failed: ${launchedGuard.stderr.slice(0, 1000)}`);
    watchdog = JSON.parse(launchedGuard.stdout.trim());
    await wait('independent guard ready', 10_000, async () => {
      const failed = jsonFile(path.join(root, 'watchdog.error.json'));
      requireThat(!failed, 'watchdog-spawn', `Independent guard failed: ${failed?.message}`);
      const ready = jsonFile(path.join(root, 'watchdog.ready.json'));
      return ready?.pid === watchdog.pid && ready.controller === process.pid;
    });
    const stdout = fs.openSync(path.join(root, 'host.stdout.log'), 'wx', 0o600);
    const stderr = fs.openSync(path.join(root, 'host.stderr.log'), 'wx', 0o600);
    phase = 'initial-boot';
    initialChild = spawn(baselineExe, ['--dev-profile', profile], { env, cwd: root, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr] });
    fs.closeSync(stdout); fs.closeSync(stderr);
    let spawnError; initialChild.on('error', error => { spawnError = error; });
    await delay(100);
    requireThat(!spawnError && initialChild.pid, 'host-spawn', 'The isolated debug Tauri host could not be started');
    currentPage = await ownPage(baselineExe);
    initialHost = currentPage.host;
    requireThat(initialHost.pid === initialChild.pid, 'host-identity', 'The page did not belong to the launched fixture host');
    report.engineProbeIsolation = await currentPage.connection.evaluate(`(async()=>{
      const invoke=window.__TAURI_INTERNALS__.invoke;
      let pickerError=null;
      try { await invoke('cursor_model_catalog'); } catch(error) { pickerError=String(error); }
      const generic=await invoke('list_engine_models',{engine:'cursor',workspace:null});
      return {pickerError,generic};
    })()`);
    requireThat(report.engineProbeIsolation.pickerError?.includes('disabled in development profiles')
      && report.engineProbeIsolation.generic.authoritative === false
      && report.engineProbeIsolation.generic.models?.[0]?.id === 'auto',
      'engine-probe-isolation', 'Both native Cursor catalog paths must reject automatic discovery in the isolated profile');
    saveReport();
    phase = 'start-fake-run';
    await currentPage.connection.evaluate(`(async()=>{
      const {useChatStore}=await import('/src/features/chat/store.ts');
      await useChatStore.getState().init();
      await useChatStore.getState().addWorkspace(${JSON.stringify(workspace)});
      if (useChatStore.getState().actionError) throw new Error('fixture workspace registration failed');
      useChatStore.getState().setActiveEngine('claude');
      useChatStore.getState().startNewChat(${JSON.stringify(workspace)});
      useChatStore.getState().setPermission('manual');
      useChatStore.getState().setClaudeHaikuAssist(false);
      await useChatStore.getState().send('fixture task',[],{computerUse:false});
      return true;
    })()`, 60_000);
    if (options.managedChild) {
      const parent = await wait('parent worker and MCP client', 45_000, async () => {
        const state = await snapshot(currentPage);
        return state.ready && state.sessionId && state.text && manifests().length === 1
          && jsonFile(path.join(workspace, 'self-update-mcp-ready.json')) ? state : null;
      });
      parentSessionId = parent.sessionId;
      parentWorkerBefore = manifests()[0];
      // Exactly one command ID is sent; the helper and native receipt each
      // retain it. No polling path resubmits task_spawn.
      writeMcpCommand({ id: 'managed-child-spawn', action: 'spawn' });
      await mcpReceipt('managed-child-spawn');
      managedBranch = await wait('managed child native session and worker', 45_000, async () => {
        const branches = (await branchSnapshot()).branches?.filter(branch =>
          branch.parentSessionId === parentSessionId && branch.parentEngine === 'claude'
          && branch.workspacePath === workspace && branch.title === 'Managed smoke child') ?? [];
        requireThat(branches.length <= 1, 'duplicate-branch', 'Managed spawn created duplicate branches');
        const branch = branches[0];
        return branch?.sessionId && branch.runId && manifests().some(item => item.runId === branch.runId)
          && fakePid() ? branch : null;
      });
      requireThat(manifests().length === 2, 'managed-workers', 'Expected one parent and one child worker');
      const parentLaunches = fs.readFileSync(path.join(workspace, 'launches.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean);
      requireThat(parentLaunches.length === 1, 'duplicate-parent', 'Parent CLI was launched more than once');
      await currentPage.connection.evaluate(`(async()=>{
        const {useChatStore}=await import('/src/features/chat/store.ts');
        await useChatStore.getState().selectSession('claude',${JSON.stringify(managedBranch.sessionId)},${JSON.stringify(workspace)});return true;
      })()`);
    }
    const initial = await wait('first actual worker and fake CLI output', 45_000, async () => {
      const state = await snapshot(currentPage);
      const found = manifests();
      if (!state.ready || !state.sessionId || !state.text || found.length !== (options.managedChild ? 2 : 1) || !fakePid()) return null;
      const target = options.managedChild ? found.find(item => item.runId === managedBranch.runId) : found[0];
      if (!target || (options.managedChild && state.sessionId !== managedBranch.sessionId)) return null;
      const count = frames(state.text); if (count < 3) return null;
      return { state, manifest: target };
    });
    const processes = await inventory();
    const worker = processes.find(item => item.pid === initial.manifest.pid && item.role === 'worker');
    const native = processes.find(item => item.pid === fakePid() && item.role === 'fake-cli');
    requireThat(worker && native && worker.started === initial.manifest.processStartTime, 'process-identity', 'Original worker/fake CLI identities were not verifiable');
    workerBefore = { workerId: initial.manifest.workerId, runId: initial.manifest.runId, workerPid: worker.pid,
      workerStarted: worker.started, workerExecutable: worker.executable, fakePid: native.pid, fakeStarted: native.started };
    requireThat(launches().length === 1, 'duplicate-launch', 'Version probes or initialization launched more than one fake task');
    await currentPage.connection.evaluate(`(async()=>{
      const {useChatStore,sessionKey}=await import('/src/features/chat/store.ts');
      const s=useChatStore.getState(),a=s.active;
      if (!a || a.workspacePath!==${JSON.stringify(workspace)} || !a.sessionId) throw new Error('fixture active session mismatch');
      s.setDraft(sessionKey(a.engine,a.sessionId,a.workspacePath),${JSON.stringify(DRAFT)});return true;
    })()`);
    const beforeGood = await readySnapshot(currentPage, 2);
    requireThat(Number.isSafeInteger(beforeGood.cursors[workerBefore.workerId]) && beforeGood.cursors[workerBefore.workerId] > 0,
      'initial-cursor', 'The real frontend did not consume the worker source');
    const mcpClient = await wait('originating task MCP client ready', 30_000,
      async () => jsonFile(path.join(workspace, 'self-update-mcp-ready.json')));
    report.mcpClient = mcpClient;
    webIdentity = await currentPage.connection.evaluate("window.__TAURI_INTERNALS__.invoke('web_access_start')");
    remote = new FixtureRemoteObserver({ port: webIdentity.port, token: webIdentity.token, streamId: workerBefore.workerId });
    await remote.start();
    const remoteBeforeGood = await assertRemote(currentPage, 1, beforeGood.text);

    phase = 'successful-handoff'; event(phase);
    const transaction = await stage(currentPage, goodPackage, goodRelease);
    const goodExe = path.join(profile, 'runtime-updates/releases', goodPackage.manifestSha256, 'ccgui-next.exe');
    currentPage.connection.close();
    currentPage = await ownPage(goodExe, new Set([initialHost.pid]), HANDOFF_TIMEOUT);
    const committed = await wait('candidate health commit', 60_000, async () => {
      const state = readUpdate();
      if (state?.transaction?.id !== transaction.id) return null;
      requireThat(!['Failed', 'RolledBack'].includes(state.transaction.phase), 'unexpected-rollback', 'The healthy candidate failed activation');
      return state.transaction.phase === 'Committed' ? state : null;
    });
    const afterGood = await readySnapshot(currentPage, beforeGood.frameCount + 2);
    requireThat(afterGood.text.startsWith(beforeGood.text) && afterGood.sessionId === beforeGood.sessionId, 'handoff-prefix', 'Successful handoff changed the existing session or its text prefix');
    requireThat(afterGood.cursors[workerBefore.workerId] >= beforeGood.cursors[workerBefore.workerId], 'handoff-cursor', 'Successful handoff regressed the worker cursor');
    requireThat(!(await inventory()).some(item => item.pid === initialHost.pid && item.started === initialHost.started), 'old-host-alive', 'The old GUI host did not exit');
    await assertProcesses(workerBefore);
    const restoredBranch = await assertManagedBranch();
    const remoteAfterGood = await assertRemote(currentPage, remoteBeforeGood.helloCount + 1, beforeGood.text);
    const goodReceipt = await mcpReceipt(goodRelease);
    requireThat(goodReceipt.accepted === true && goodReceipt.transactionId === transaction.id,
      'mcp-acceptance', 'Originating task did not receive the accepted update identity');
    writeMcpCommand({ id: 'good-status', action: 'status', manifestSha256: goodPackage.manifestSha256 });
    const goodStatus = await mcpReceipt('good-status');
    requireThat(goodStatus.matchesTransaction && goodStatus.matchesActive && goodStatus.state?.transaction?.phase === 'Committed',
      'mcp-status', 'Originating task could not confirm the committed self-update');
    report.results.push({ scenario: 'successful-handoff', passed: true, transactionId: transaction.id,
      phase: committed.transaction.phase, releaseId: committed.active?.releaseId,
      before: summarize({ host: initialHost }, beforeGood), after: summarize(currentPage, afterGood),
      remoteBefore: remoteBeforeGood, remoteAfter: remoteAfterGood, initiatedByTaskMcp: true, taskConfirmedCommitted: true,
      ...(restoredBranch ? { managedBranch: { id: restoredBranch.id, runId: restoredBranch.runId,
        sessionId: restoredBranch.sessionId, parentSessionId: restoredBranch.parentSessionId } } : {}) });
    saveReport(); event(phase, { passed: true, sameWorker: true, sameFakeCli: true, launches: 1 });

    // A successful first replacement must also admit a NEW independent worker,
    // otherwise a restrictive outer Job can leave the new GUI unable to work.
    if (!options.managedChild) {
    phase = 'new-task-after-update'; event(phase);
    writeNew(path.join(successorWorkspace, 'keep-running'), 'owned successor task\n');
    await currentPage.connection.evaluate(`(async()=>{
      const native=(command,args)=>window.__TAURI_INTERNALS__.invoke(command,args);
      const settings=await native('get_app_settings');
      await native('update_app_settings',{settings:{...settings,claudeBin:${JSON.stringify(successorFake)}}});
      const {useChatStore}=await import('/src/features/chat/store.ts');
      const s=useChatStore.getState();
      await s.addWorkspace(${JSON.stringify(successorWorkspace)});
      s.setActiveEngine('claude');s.startNewChat(${JSON.stringify(successorWorkspace)});
      s.setPermission('manual');s.setClaudeHaikuAssist(false);
      await useChatStore.getState().send('fixture successor task',[],{computerUse:false});return true;
    })()`);
    const successor = await wait('new worker from committed executable', 30_000, async () => {
      const manifest = manifests().find(item => item.workerId !== workerBefore.workerId);
      const emitted = path.join(successorWorkspace, 'emitted.seq');
      if (!manifest || !fs.existsSync(emitted) || Number(fs.readFileSync(emitted, 'utf8')) < 3) return null;
      requireThat(pathKey(manifest.executable) === pathKey(goodExe), 'successor-worker-executable', 'New task did not use the committed executable');
      return { workerPid: manifest.pid, workerId: manifest.workerId };
    });
    fs.unlinkSync(path.join(successorWorkspace, 'keep-running'));
    await wait('new task settlement', 20_000, async () => currentPage.connection.evaluate(`(async()=>{
      const {useChatStore,sessionKey}=await import('/src/features/chat/store.ts');const s=useChatStore.getState(),a=s.active;
      const entry=a&&s.bySession[sessionKey(a.engine,a.sessionId,a.workspacePath)];return !!entry&&!entry.streaming;
    })()`));
    await currentPage.connection.evaluate(`(async()=>{
      const native=(command,args)=>window.__TAURI_INTERNALS__.invoke(command,args);
      const settings=await native('get_app_settings');await native('update_app_settings',{settings:{...settings,claudeBin:${JSON.stringify(fake)}}});
      const {useChatStore}=await import('/src/features/chat/store.ts');
      await useChatStore.getState().selectSession('claude',${JSON.stringify(beforeGood.sessionId)},${JSON.stringify(workspace)});return true;
    })()`);
    await assertProcesses(workerBefore);
    report.results.push({ scenario: 'new-task-after-update', passed: true, ...successor, usesCommittedExecutable: true });
    saveReport(); event(phase, { passed: true });
    }

    if (options.rollback !== false) {
      phase = 'candidate-health-rollback'; event(phase, { nativeHealthDeadlineMs: 120_000 });
      const previousHost = currentPage.host;
      const beforeBad = await readySnapshot(currentPage, afterGood.frameCount);
      const badTransaction = await stage(currentPage, badPackage, badRelease);
      const badExe = path.join(profile, 'runtime-updates/releases', badPackage.manifestSha256, 'ccgui-next.exe');
      currentPage.connection.close();
      const rejectedPage = await ownPage(badExe, new Set([previousHost.pid]), HANDOFF_TIMEOUT);
      currentPage = rejectedPage;
      const rejected = await snapshot(rejectedPage);
      requireThat(rejected.inert, 'failure-hook-not-active', 'Failure candidate became usable before its expected health rejection');
      await assertProcesses(workerBefore);
      const rolledBack = await wait('real health timeout and native rollback', ROLLBACK_TIMEOUT, async () => {
        const state = readUpdate();
        if (state?.transaction?.id !== badTransaction.id) return null;
        requireThat(state.transaction.phase !== 'Committed', 'failure-hook-not-active', 'The intentionally unhealthy candidate committed; build the fixture health-rejection hook');
        return state.transaction.phase === 'RolledBack' ? state : null;
      }, 500);
      requireThat(rolledBack.transaction.failureReason === 'CandidateHealthTimeout', 'wrong-rollback-cause', 'Rollback was not caused by the real candidate health deadline');
      rejectedPage.connection.close();
      currentPage = await ownPage(goodExe, new Set([previousHost.pid, rejectedPage.host.pid]), BOOT_TIMEOUT);
      const afterRollback = await readySnapshot(currentPage, beforeBad.frameCount + 2);
      requireThat(afterRollback.text.startsWith(beforeBad.text) && afterRollback.sessionId === beforeBad.sessionId, 'rollback-prefix', 'Rollback changed the session or lost its exact text prefix');
      requireThat(afterRollback.cursors[workerBefore.workerId] >= beforeBad.cursors[workerBefore.workerId], 'rollback-cursor', 'Rollback regressed the worker cursor');
      requireThat(rolledBack.active?.releaseId === goodRelease, 'rollback-release', 'Rollback did not restore the previously committed release');
      const afterProcesses = await inventory();
      requireThat(!afterProcesses.some(item => [previousHost.pid, rejectedPage.host.pid].includes(item.pid)), 'retired-host-alive', 'A retired fixture host remained alive after rollback');
      await assertProcesses(workerBefore);
      const remoteAfterRollback = await assertRemote(currentPage, remoteAfterGood.helloCount + 1, beforeBad.text);
      const rolledBackBranch = options.managedChild ? await assertManagedBranch() : null;
      const badReceipt = await mcpReceipt(badRelease);
      requireThat(badReceipt.accepted === true && badReceipt.transactionId === badTransaction.id,
        'mcp-acceptance', 'Originating task lost the failed candidate preparation result');
      writeMcpCommand({ id: 'rollback-status', action: 'status', manifestSha256: badPackage.manifestSha256 });
      const rollbackStatus = await mcpReceipt('rollback-status');
      requireThat(rollbackStatus.matchesTransaction && !rollbackStatus.matchesActive
        && rollbackStatus.state?.transaction?.phase === 'RolledBack', 'mcp-status', 'Originating task could not inspect rollback');
      report.results.push({ scenario: 'candidate-health-rollback', passed: true, transactionId: badTransaction.id,
        phase: rolledBack.transaction.phase, failureReason: rolledBack.transaction.failureReason,
        before: summarize({ host: previousHost }, beforeBad), after: summarize(currentPage, afterRollback),
        remoteAfter: remoteAfterRollback, initiatedByTaskMcp: true, taskConfirmedRollback: true,
        ...(rolledBackBranch ? { managedBranch: { id: rolledBackBranch.id, runId: rolledBackBranch.runId,
          sessionId: rolledBackBranch.sessionId, parentSessionId: rolledBackBranch.parentSessionId } } : {}) });
      saveReport(); event(phase, { passed: true, sameWorker: true, sameFakeCli: true, launches: 1 });
    } else {
      report.results.push({ scenario: 'candidate-health-rollback', passed: null, reason: 'Explicit --no-rollback selection' });
    }

    phase = 'final-drain';
    if (options.managedChild) {
      phase = 'managed-child-stop'; event(phase);
      // Quiesce only fake output (not its process or reader) to make the final
      // emitted-frame count exact across an asynchronous real Interrupt.
      writeNew(path.join(taskOutput, 'pause-before-stop'), 'fixture output gate\n');
      await wait('managed fake output paused', 10_000, async () => fs.existsSync(path.join(taskOutput, 'paused-for-stop')));
      writeMcpCommand({ id: 'managed-child-stop', action: 'stop', branchId: managedBranch.id });
      await mcpReceipt('managed-child-stop');
      await assertManagedBranch('stopped');
      await wait('managed child registration retired', 30_000, async () => currentPage.connection.evaluate(
        `window.__TAURI_INTERNALS__.invoke('active_run_ids',{runIds:[${JSON.stringify(managedBranch.runId)}]}).then(ids=>ids.length===0)`));
      requireThat(fs.existsSync(path.join(taskOutput, 'keep-running')), 'managed-cancel', 'Child lifetime marker was removed instead of cancelling through MCP');
      report.results.push({ scenario: 'managed-child-stop', passed: true, branchId: managedBranch.id, viaParentTaskMcp: true, registryRetired: true });
    } else fs.unlinkSync(inside(root, path.join(workspace, 'keep-running')));
    await wait('fake CLI clean exit', 20_000, async () => !(await inventory()).some(item => item.pid === workerBefore.fakePid && item.started === workerBefore.fakeStarted));
    const finalCount = Number(fs.readFileSync(path.join(taskOutput, 'emitted.seq'), 'utf8').trim());
    const final = await wait('complete final GUI stream', 30_000, async () => {
      const value = await snapshot(currentPage);
      if (!value.ready || value.streaming || !value.text) return null;
      const count = frames(value.text);
      return count === finalCount ? { ...value, frameCount: count } : null;
    });
    requireThat(final.draft === DRAFT && final.draftVisible, 'final-draft', 'Final stream settlement changed the unsent draft');
    requireThat(launches().length === 1, 'duplicate-launch', 'More than one fake CLI task was launched');
    await remote.sync();
    requireThat(!remote.error && remote.text === final.text, 'remote-final-text', 'Remote and GUI final delivery differ');
    report.remoteFinal = { ...remote.summary, exactFullDelivery: true, textSha256: sha256(remote.text) };
    report.finalStream = { ...summarize(currentPage, final), emittedFrames: finalCount, exactFullDelivery: true };
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = { phase, code: error.code ?? 'unexpected', message: String(error.message ?? error).slice(0, 1200) };
    event('failed', { at: phase, code: report.failure.code });
  } finally {
    phase = 'cleanup';
    const errors = [];
    try {
      const marker = inside(root, path.join(workspace, 'keep-running'));
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
      const successorMarker = inside(root, path.join(successorWorkspace, 'keep-running'));
      if (fs.existsSync(successorMarker)) fs.unlinkSync(successorMarker);
      if (env && ps && fs.existsSync(helper)) {
        // Stop only verified fixture supervisors first: a still-running timeout
        // supervisor must not launch another GUI after cleanup has enumerated it.
        for (const item of (await inventory()).filter(item => item.role === 'supervisor')) {
          await processCommand('terminate', item);
        }
        for (const manifest of manifests()) await privateShutdown(manifest);
        if (ownedProfileConfirmed && currentPage && !currentPage.connection.closed) {
          try { await currentPage.connection.evaluate("(()=>{void window.__TAURI_INTERNALS__.invoke('plugin:process|exit',{code:0});return true;})()", 2000); }
          catch { /* The expected process exit can close the page before its response. */ }
        }
        await delay(1200);
        const roles = ['worker', 'host-mcp', 'host', 'fake-cli', 'webview'];
        for (const role of roles) {
          for (const item of (await inventory()).filter(item => item.role === role)) {
            try { await processCommand('terminate', item); } catch (error) { errors.push(error.code ?? 'cleanup-process'); }
          }
        }
        // The independent guard is cancelled last, after all GUI/worker/CLI
        // owners have been stopped. It remains armed if Node exits mid-cleanup.
        const workRemaining = (await inventory()).filter(item => item.role !== 'watchdog');
        if (workRemaining.length === 0) {
          writeNew(path.join(root, 'watchdog.cancel'), 'fixture cleanup completed\n');
          await delay(600);
          for (const item of (await inventory()).filter(item => item.role === 'watchdog')) {
            try { await processCommand('terminate', item); } catch (error) { errors.push(error.code ?? 'cleanup-watchdog'); }
          }
        } else {
          report.cleanup.lifetimeGuardLeftArmed = true;
        }
        const remaining = await inventory();
        report.cleanup.remainingOwnedPids = remaining.map(item => ({ pid: item.pid, role: item.role }));
        report.cleanup.complete = remaining.length === 0 && errors.length === 0;
      } else { report.cleanup.complete = !initialChild?.pid; }
    } catch (error) { errors.push(error.code ?? 'cleanup'); }
    for (const connection of connections) connection.close();
    remote?.close();
    report.cleanup.errors = errors;
    if (!report.cleanup.complete) { report.status = 'failed'; report.failure ??= { phase: 'cleanup', code: 'cleanup-incomplete', message: 'Fixture-owned processes could not all be verified as stopped' }; }
    report.finishedAt = new Date().toISOString();
    saveReport();
    process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
    event('complete', { status: report.status, report: reportPath, cleanupComplete: report.cleanup.complete });
  }
  return { report, reportPath, exitCode: report.status === 'passed' ? 0 : abort.signal.aborted ? 130 : 1 };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('node scripts/test-live-update-smoke.mjs --exe <cargo-built-debug-test-harness.exe> --url http://localhost:1420 [--resources <resource-tree>] [--artifacts <artifact-parent>] [--no-rollback] [--managed-child --no-rollback]');
    else process.exitCode = (await runSmoke(options)).exitCode;
  } catch (error) {
    console.error(JSON.stringify({ event: 'live-update-smoke', status: 'failed', code: error.code ?? 'setup', message: String(error.message ?? error).slice(0, 1200) }));
    process.exitCode = 1;
  }
}
