//! Bounded elevation and same-integrity supervision of the firewall installer.
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;

const FAILED: &str = "firewall_install_failed";
const TIMEOUT: &str = "firewall_install_timeout";
const TOTAL_LIMIT: Duration = Duration::from_secs(120);
const SCRIPT_LIMIT: Duration = Duration::from_secs(60);
const RUST_LIMIT: Duration = Duration::from_secs(150);

fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn encoded(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn deadline_after(limit: Duration) -> u128 {
    // UTC .NET DateTime ticks, passed as a decimal literal to Windows PowerShell.
    621_355_968_000_000_000
        + (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            + limit.as_nanos())
            / 100
}

fn installer_script(script: &Path, executable: &Path, deadline: u128) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; try {{ if ([DateTime]::UtcNow.Ticks -ge {deadline}) {{ exit 124 }}; & {} -Mode Install -GuiExe {} *> $null; if (-not $?) {{ exit 1 }}; exit 0 }} catch {{ exit 1 }}",
        quoted(&script.to_string_lossy()), quoted(&executable.to_string_lossy())
    )
}

// Runs elevated in production. It owns the installer at the same integrity
// level, so cleanup never depends on a non-elevated process killing an admin one.
fn supervisor_script(
    powershell: &Path,
    installer: &str,
    deadline: u128,
    limit: Duration,
) -> String {
    format!(
        r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$p = $null
$result = 1
try {{
    $remaining = [Math]::Floor(({deadline} - [DateTime]::UtcNow.Ticks) / 10000)
    if ($remaining -le 0) {{ exit 124 }}
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = {powershell}
    $info.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {installer}'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $info
    if (-not $p.Start()) {{ throw 'Installer did not start' }}
    $stdout = $p.StandardOutput.BaseStream.CopyToAsync([System.IO.Stream]::Null)
    $stderr = $p.StandardError.BaseStream.CopyToAsync([System.IO.Stream]::Null)
    $remaining = [Math]::Floor(({deadline} - [DateTime]::UtcNow.Ticks) / 10000)
    $wait = [int][Math]::Max(0, [Math]::Min({limit_ms}, $remaining))
    if ($p.WaitForExit($wait)) {{ $result = $p.ExitCode }} else {{ $result = 124 }}
}} catch {{ $result = 1 }} finally {{
    if ($null -ne $p) {{
        try {{
            if (-not $p.HasExited) {{ $p.Kill(); [void]$p.WaitForExit(2000) }}
        }} catch {{ $result = 1 }}
        $p.Dispose()
    }}
}}
exit $result
"#,
        powershell = quoted(&powershell.to_string_lossy()),
        installer = encoded(installer),
        limit_ms = limit.as_millis(),
    )
}

fn elevation_script(powershell: &Path, supervisor: &str, deadline: u128, elevate: bool) -> String {
    format!(
        r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {{
    if ([DateTime]::UtcNow.Ticks -ge {deadline}) {{ exit 124 }}
    $p = Start-Process -FilePath {powershell} {verb} -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {supervisor}'
    if ($null -eq $p) {{ exit 1 }}
    $handle = $p.Handle
    $remaining = [int][Math]::Max(0, [Math]::Floor(({deadline} - [DateTime]::UtcNow.Ticks) / 10000))
    if (-not $p.WaitForExit($remaining)) {{ exit 124 }}
    $code = $p.ExitCode
    $p.Dispose()
    if ($null -eq $code) {{ exit 1 }}
    exit $code
}} catch {{ exit 1 }}
"#,
        powershell = quoted(&powershell.to_string_lossy()),
        supervisor = encoded(supervisor),
        verb = if elevate { "-Verb RunAs" } else { "" },
    )
}

pub(super) fn install(
    powershell: &Path,
    script: &Path,
    executable: &Path,
) -> Result<(), &'static str> {
    let deadline = deadline_after(TOTAL_LIMIT);
    let installer = installer_script(script, executable, deadline);
    let supervisor = supervisor_script(powershell, &installer, deadline, SCRIPT_LIMIT);
    run_bounded(
        powershell,
        &elevation_script(powershell, &supervisor, deadline, true),
        RUST_LIMIT,
    )
}

fn run_bounded(powershell: &Path, script: &str, limit: Duration) -> Result<(), &'static str> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| FAILED)?;
    runtime.block_on(async {
        let mut command = tokio::process::Command::new(powershell);
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                &encoded(script),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| FAILED)?;
        match tokio::time::timeout(limit, child.wait()).await {
            Ok(Ok(status)) if status.success() => Ok(()),
            Ok(Ok(status)) if status.code() == Some(124) => Err(TIMEOUT),
            Ok(_) => Err(FAILED),
            Err(_) => {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                Err(TIMEOUT)
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "ccgui firewall ' test {}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn run(&self, body: &str, limit: Duration, deadline: u128) -> Result<(), &'static str> {
            let script = self.0.join("fake install ' script.ps1");
            std::fs::write(&script, body).unwrap();
            let installer =
                installer_script(&script, &self.0.join("candidate ' app.exe"), deadline);
            let ps = super::super::powershell_exe();
            run_bounded(
                &ps,
                &supervisor_script(&ps, &installer, deadline, limit),
                Duration::from_secs(15),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn firewall_installer_preserves_paths_and_failures() {
        let fixture = Fixture::new();
        let deadline = deadline_after(Duration::from_secs(30));
        let body = format!("param($Mode, $GuiExe)\nif ($Mode -ne 'Install' -or $GuiExe -ne {}) {{ exit 1 }}\nWrite-Output ('x' * 100000); [Console]::Error.WriteLine(('e' * 100000)); exit 0", quoted(&fixture.0.join("candidate ' app.exe").to_string_lossy()));
        assert_eq!(fixture.run(&body, Duration::from_secs(5), deadline), Ok(()));
        assert_eq!(
            fixture.run("exit 1", Duration::from_secs(5), deadline),
            Err(FAILED)
        );
        assert_eq!(
            fixture.run("throw 'failed'", Duration::from_secs(5), deadline),
            Err(FAILED)
        );
    }

    #[test]
    fn firewall_installer_timeout_reaps_child() {
        let fixture = Fixture::new();
        let pid_file = fixture.0.join("pid.txt");
        let body = format!(
            "[IO.File]::WriteAllText({}, [string]$PID); Start-Sleep -Seconds 30",
            quoted(&pid_file.to_string_lossy())
        );
        let started = Instant::now();
        assert_eq!(
            fixture.run(
                &body,
                Duration::from_secs(2),
                deadline_after(Duration::from_secs(20))
            ),
            Err(TIMEOUT)
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        let pid = std::fs::read_to_string(pid_file).unwrap();
        assert_eq!(
            run_bounded(
                &super::super::powershell_exe(),
                &format!(
                    "if (Get-Process -Id {} -ErrorAction SilentlyContinue) {{ exit 1 }}",
                    pid.trim()
                ),
                Duration::from_secs(5)
            ),
            Ok(())
        );
    }

    #[test]
    fn firewall_installer_expired_deadline_does_not_execute() {
        let fixture = Fixture::new();
        let marker = fixture.0.join("must-not-exist");
        assert_eq!(
            fixture.run(
                &format!(
                    "[IO.File]::WriteAllText({}, 'ran')",
                    quoted(&marker.to_string_lossy())
                ),
                Duration::from_secs(2),
                1
            ),
            Err(TIMEOUT)
        );
        assert!(!marker.exists());
    }

    #[test]
    fn firewall_outer_watchdog_bounds_hang() {
        let started = Instant::now();
        assert_eq!(
            run_bounded(
                &super::super::powershell_exe(),
                "Start-Sleep -Seconds 30",
                Duration::from_millis(300)
            ),
            Err(TIMEOUT)
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn firewall_elevation_wrapper_preserves_exit_status_without_uac() {
        let ps = super::super::powershell_exe();
        for (script, expected) in [
            ("exit 0", Ok(())),
            ("exit 1", Err(FAILED)),
            ("exit 124", Err(TIMEOUT)),
        ] {
            let wrapper =
                elevation_script(&ps, script, deadline_after(Duration::from_secs(10)), false);
            assert_eq!(
                run_bounded(&ps, &wrapper, Duration::from_secs(15)),
                expected
            );
        }
    }
}
