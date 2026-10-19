use std::{env, ffi::OsString, process::{self, Command}};

fn main() {
    let mut args = env::args_os().skip(1);
    let compiler = args.next().unwrap_or_else(|| fail());
    let original = env::var_os("CCGUI_RELEASE_ORIGINAL_RUSTC_WRAPPER")
        .filter(|value| !value.is_empty());
    let mut command = Command::new(original.as_ref().unwrap_or(&compiler));
    if original.is_some() {
        command.arg(&compiler);
    }
    command.args(args);
    // Keep Cargo's dependency metadata local so unchanged builds stay fresh.
    // Only paths emitted into distributable object code need sanitizing.
    command.arg("--remap-path-scope=object");
    let mappings = env::var("CCGUI_RELEASE_REMAP_ARGS").unwrap_or_else(|_| fail());
    for mapping in mappings.split('\x1f') {
        if !mapping.starts_with("--remap-path-prefix=") {
            fail();
        }
        command.arg(OsString::from(mapping));
    }
    match command.status() {
        Ok(status) => {
            if let Some(code) = status.code() {
                process::exit(code);
            }
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                process::exit(128 + status.signal().unwrap_or(1));
            }
            #[cfg(not(unix))]
            process::exit(1);
        }
        Err(_) => fail(),
    }
}

fn fail() -> ! {
    eprintln!("Release compiler wrapper failed");
    process::exit(1);
}
