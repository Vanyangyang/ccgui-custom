//! A fail-closed launch barrier for native CLI actions on Windows.
//!
//! Caller contract: spawn the prepared command, assign its wrapper to a
//! kill-on-close Job, retain that Job for the entire operation, and ONLY then
//! call `release`. Never replace stdin or append CLI arguments to this command.
//! On assignment failure, drop stdin and kill/reap the wrapper. Cancellation
//! before release cannot start the CLI; after release commits, cancellation
//! must close the Job (and kill/reap the wrapper). This module cannot verify Job
//! membership or undo a release that has already reached the child.
//!
//! CLI stdin is EOF. Native stdout/stderr are copied without transcoding;
//! native programs must emit UTF-8 themselves. PowerShell script output uses
//! UTF-8 without a BOM. No PowerShell profiles, cmd AutoRun, file associations,
//! aliases or functions participate in launch. `.ps1` uses Windows PowerShell
//! 5.1 semantics; `.cmd`/`.bat` arguments reject shell metacharacters, even if
//! those characters would be meaningful literal arguments to another CLI.

#![cfg(windows)]

use base64::Engine;
use std::{path::PathBuf, process::Stdio};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, Command},
};

const PAYLOAD_ENV: &str = "CCGUI_GUARDED_CLI_PAYLOAD";
const START_TOKEN: &[u8] = b"CCGUI-CLI-START-v1";

// This is executable code, never a template. User data appears only in the
// JSON environment value. The first CLI lookup, JSON parse and process launch
// all occur AFTER an exact, bounded token followed by EOF has been received.
const WRAPPER: &str = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSModuleAutoLoadingPreference = 'None'
try {
    $inputStream = [Console]::OpenStandardInput()
    foreach ($expected in [Text.Encoding]::ASCII.GetBytes('CCGUI-CLI-START-v1')) {
        if ($inputStream.ReadByte() -ne $expected) { exit 125 }
    }
    if ($inputStream.ReadByte() -ne -1) { exit 125 }
    $utf8 = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
    # Load JSON support from the trusted system installation, not PSModulePath.
    Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
    $payload = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $env:CCGUI_GUARDED_CLI_PAYLOAD
    [Environment]::SetEnvironmentVariable('CCGUI_GUARDED_CLI_PAYLOAD', $null, 'Process')
    [string]$bin = $payload.bin
    [string[]]$cliArgs = @($payload.args)
    if ([IO.File]::Exists($bin)) {
        $target = [IO.Path]::GetFullPath($bin)
    } else {
        # Only bare names may use PATH discovery; never wildcard lookup.
        if ($bin.IndexOfAny([char[]]'\/:*?[]') -ge 0) { throw 'Invalid CLI path' }
        $resolved = @(Get-Command -Name $bin -CommandType Application,ExternalScript -ErrorAction Stop)
        $target = $resolved[0].Path
    }
    $extension = [IO.Path]::GetExtension($target).ToLowerInvariant()
    if ($extension -eq '.ps1') {
        # Array splatting preserves zero/one/empty arguments, unlike PS 5.1's
        # native argument marshaller. Invocation never evaluates argument text.
        $global:LASTEXITCODE = 0
        $PSModuleAutoLoadingPreference = 'All'
        $ErrorActionPreference = 'Continue'
        & $target @cliArgs
        exit $LASTEXITCODE
    }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.WorkingDirectory = [Environment]::CurrentDirectory
    if ($extension -eq '.cmd' -or $extension -eq '.bat') {
        # cmd needs a command string. It contains ONLY generated environment
        # references, never user text. Quotes/metacharacters are rejected before
        # expansion; /d and /v:off disable AutoRun and delayed expansion.
        if ($target.IndexOfAny([char[]]'"%!') -ge 0 -or $target.Contains("`r") -or $target.Contains("`n")) {
            throw 'Unsupported batch path'
        }
        $start.FileName = [string]$payload.cmd
        $start.EnvironmentVariables['CCGUI_GUARDED_TARGET'] = $target
        $parts = @('"%CCGUI_GUARDED_TARGET%"')
        for ($i = 0; $i -lt $cliArgs.Count; $i++) {
            $value = $cliArgs[$i]
            # cmd keeps an undefined %NAME% literal; represent empty arguments
            # with a fixed empty quoted word instead of an environment lookup.
            if ($value.Length -eq 0) { $parts += '""'; continue }
            if ($value.EndsWith('\')) { throw 'Unsupported trailing backslash in batch argument' }
            if ($value.IndexOfAny([char[]]'&|<>()^%!"''') -ge 0 -or $value.Contains("`r") -or $value.Contains("`n")) {
                throw 'Unsupported batch argument'
            }
            $name = 'CCGUI_GUARDED_ARG_' + $i
            $start.EnvironmentVariables[$name] = $value
            $parts += '"%' + $name + '%"'
        }
        $start.Arguments = '/d /v:off /s /c "' + ($parts -join ' ') + '"'
    } elseif ($extension -eq '.exe' -or $extension -eq '.com') {
        # Build a Windows argv command line, NOT shell source. When quoting is
        # needed, double backslashes before quotes and before the closing quote.
        $start.FileName = $target
        $parts = @(foreach ($value in $cliArgs) {
            if ($value.Length -gt 0 -and $value -notmatch '[\s"]') {
                $value
            } else {
                $quoted = [regex]::Replace($value, '(\\*)"', '$1$1\"')
                $quoted = [regex]::Replace($quoted, '(\\+)$', '$1$1')
                '"' + $quoted + '"'
            }
        })
        $start.Arguments = $parts -join ' '
    } else {
        throw 'Unsupported CLI extension'
    }
    $process = [Diagnostics.Process]::Start($start)
    try {
        $process.StandardInput.Close()
        $stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
        $stderrCopy = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
        $process.WaitForExit()
        $null = $stdoutCopy.GetAwaiter().GetResult()
        $null = $stderrCopy.GetAwaiter().GetResult()
        $code = $process.ExitCode
    } finally {
        $process.Dispose()
    }
    exit $code
} catch {
    # Exceptions can contain paths, argv or credentials. Keep diagnostics fixed.
    [Console]::Error.WriteLine('Guarded CLI launch failed')
    exit 126
}
"#;

// Do not search PATH or trust a caller-overridden SystemRoot for the barrier
// executable. GetSystemDirectoryW also selects the appropriate WOW64 system
// directory for the architecture of this process.
fn system_directory() -> Result<PathBuf, String> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = vec![0u16; 32768];
    // SAFETY: buffer has `size` writable u16 elements and outlives the call.
    let len = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if len == 0 || len >= buffer.len() {
        return Err("Could not locate the Windows system directory".into());
    }
    use std::os::windows::ffi::OsStringExt;
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len])))
}

fn encoded_script(script: &str) -> String {
    let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub(super) fn prepare(bin: &str, args: &[String]) -> Result<Command, String> {
    if bin.trim().is_empty() || bin.contains('\0') || args.iter().any(|arg| arg.contains('\0')) {
        return Err("Invalid CLI path or argument".into());
    }
    let system = system_directory()?;
    let powershell = system.join("WindowsPowerShell/v1.0/powershell.exe");
    if !powershell.is_file() {
        return Err("Windows PowerShell is unavailable for guarded CLI launch".into());
    }
    // Windows shell/script tools do not consistently support verbatim paths.
    let bin = if let Some(unc) = bin.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        bin.strip_prefix(r"\\?\").unwrap_or(bin).to_owned()
    };
    if matches!(
        std::path::Path::new(&bin)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("cmd" | "bat")
    ) && args.iter().any(|argument| argument.ends_with('\\'))
    {
        return Err("Batch CLI cannot safely pass an argument ending in a backslash; remove the trailing backslash".into());
    }
    let payload = serde_json::to_string(&serde_json::json!({
        "bin": bin, "args": args, "cmd": system.join("cmd.exe"),
    }))
    .map_err(|_| "Could not encode guarded CLI arguments")?;
    // A Windows environment value is bounded in UTF-16 code units. Fail before
    // spawn instead of truncating a command or relying on platform ambiguity.
    if payload.encode_utf16().count() > 30000 {
        return Err("Guarded CLI arguments exceed the environment size limit".into());
    }
    let mut command = Command::new(powershell);
    crate::development_profile::configure_command(&mut command);
    command.env("PATH", crate::engine::resolve::cli_search_path());
    command.env_remove("CCGUI_SPELLCAST_COMPLETION_OWNER");
    command.env(PAYLOAD_ENV, payload);
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &encoded_script(WRAPPER),
    ]);
    command.stdin(Stdio::piped()).kill_on_drop(true);
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    Ok(command)
}

/// The exact token plus closing stdin is the launch commit. The caller MUST
/// already own the Job. Taking stdin makes a second release fail locally;
/// dropping an interrupted write closes the pipe, so incomplete tokens fail
/// closed. Once the complete token is delivered, Job ownership is the only
/// cancellation guarantee (including cancellation while shutdown is pending).
pub(super) async fn release(child: &mut Child) -> Result<(), String> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Guarded CLI stdin unavailable or already released")?;
    stdin
        .write_all(START_TOKEN)
        .await
        .map_err(|_| "Could not release guarded CLI")?;
    stdin
        .shutdown()
        .await
        .map_err(|_| "Could not close guarded CLI launch gate")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::{io::AsyncReadExt, time::timeout};

    const LIMIT: Duration = Duration::from_secs(15);

    fn echo_command() -> Command {
        let powershell = system_directory()
            .unwrap()
            .join("WindowsPowerShell/v1.0/powershell.exe");
        let args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]
            .map(str::to_owned).into_iter().chain([encoded_script(
                "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Out.Write('CLI_RAN 中文 😀'); [Console]::Error.Write('CLI_ERR'); exit 23"
            )]).collect::<Vec<_>>();
        let mut command = prepare(powershell.to_str().unwrap(), &args).unwrap();
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        command
    }

    #[tokio::test]
    async fn no_cli_output_until_release_and_exit_code_is_preserved() {
        let mut child = echo_command().spawn().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut first = [0u8; 1];
        assert!(
            timeout(Duration::from_millis(1000), stdout.read(&mut first))
                .await
                .is_err()
        );
        assert!(child.try_wait().unwrap().is_none());
        timeout(LIMIT, release(&mut child)).await.unwrap().unwrap();
        assert!(release(&mut child).await.is_err());
        let mut output = Vec::new();
        timeout(LIMIT, stdout.read_to_end(&mut output))
            .await
            .unwrap()
            .unwrap();
        let result = timeout(LIMIT, child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.status.code(), Some(23));
        assert_eq!(String::from_utf8(output).unwrap(), "CLI_RAN 中文 😀");
        assert_eq!(result.stderr, b"CLI_ERR");
    }

    #[tokio::test]
    async fn eof_wrong_partial_and_extra_tokens_never_launch() {
        for token in [
            &b""[..],
            b"wrong",
            b"CCGUI-CLI-START-v",
            b"CCGUI-CLI-START-v1\n",
        ] {
            let mut child = echo_command().spawn().unwrap();
            let mut stdin = child.stdin.take().unwrap();
            timeout(LIMIT, stdin.write_all(token))
                .await
                .unwrap()
                .unwrap();
            drop(stdin);
            let result = timeout(LIMIT, child.wait_with_output())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result.status.code(), Some(125));
            assert!(result.stdout.is_empty());
            assert!(result.stderr.is_empty());
        }
    }

    #[test]
    fn invalid_inputs_fail_before_spawn() {
        assert!(prepare("", &[]).is_err());
        assert!(prepare("cmd.exe", &["bad\0arg".into()]).is_err());
        assert!(prepare("cmd.exe", &["x".repeat(30001)]).is_err());
        assert!(prepare("example.cmd", &[r"C:\space path\".into()]).is_err());
    }

    #[tokio::test]
    async fn batch_forwarding_keeps_arguments_and_rejects_trailing_backslash() {
        let root = std::env::temp_dir().join(format!("ccgui-guard-batch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let script = root.join("echo.ps1");
        let batch = root.join("relay.cmd");
        std::fs::write(
            &script,
            "[Console]::Out.Write((ConvertTo-Json -InputObject @($args) -Compress))",
        )
        .unwrap();
        let powershell = system_directory()
            .unwrap()
            .join("WindowsPowerShell/v1.0/powershell.exe");
        std::fs::write(
            &batch,
            format!(
                "@echo off\r\n\"{}\" -NoProfile -File \"%~dp0echo.ps1\" %*\r\n",
                powershell.display()
            ),
        )
        .unwrap();
        let args = vec![
            r"C:\space path".to_owned(),
            "--scope".to_owned(),
            "project".to_owned(),
        ];
        let mut command = prepare(batch.to_str().unwrap(), &args).unwrap();
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        timeout(LIMIT, release(&mut child)).await.unwrap().unwrap();
        let output = timeout(LIMIT, child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert!(output.status.success());
        let decoded: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(decoded, args);
        let mut unsafe_args = args;
        unsafe_args[0].push('\\');
        assert!(prepare(batch.to_str().unwrap(), &unsafe_args).is_err());
        // Simulate a bare command whose target is only resolved inside the
        // wrapper, after the Rust preflight has already accepted its name.
        let mut resolved_batch = prepare("bare-command", &unsafe_args).unwrap();
        resolved_batch.env(
            PAYLOAD_ENV,
            serde_json::json!({
                "bin": batch,
                "args": unsafe_args,
                "cmd": system_directory().unwrap().join("cmd.exe"),
            })
            .to_string(),
        );
        resolved_batch.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = resolved_batch.spawn().unwrap();
        timeout(LIMIT, release(&mut child)).await.unwrap().unwrap();
        let rejected = timeout(LIMIT, child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rejected.status.code(), Some(126));
        assert!(rejected.stdout.is_empty());
        std::fs::remove_file(script).unwrap();
        std::fs::remove_file(batch).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
