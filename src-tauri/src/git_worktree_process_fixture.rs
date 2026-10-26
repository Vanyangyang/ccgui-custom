// Standalone local process fixture, compiled by the process regression tests.
use std::os::windows::process::CommandExt;
use std::{
    io::{Read, Write},
    time::Duration,
};
#[link(name = "kernel32")]
extern "system" {
    fn GetConsoleWindow() -> *mut std::ffi::c_void;
}
#[link(name = "user32")]
extern "system" {
    fn IsWindowVisible(window: *mut std::ffi::c_void) -> i32;
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("query");
    if let Some(path) = args.get(2) {
        std::fs::write(format!("{path}.parent"), std::process::id().to_string()).unwrap();
        let window = unsafe { GetConsoleWindow() };
        let visible = !window.is_null() && unsafe { IsWindowVisible(window) } != 0;
        std::fs::write(format!("{path}.visible"), visible.to_string()).unwrap();
    }
    match mode {
        "hold" | "refuse" => {
            if let Some(path) = args.get(2) {
                std::fs::write(path, std::process::id().to_string()).unwrap();
            }
            std::thread::sleep(Duration::from_secs(30));
        }
        "fork" | "fork-live" => {
            let path = &args[2];
            let _child = std::process::Command::new(std::env::current_exe().unwrap())
                .creation_flags(0x08000000)
                .args(["hold", path])
                .spawn()
                .unwrap();
            while !std::path::Path::new(path).exists() {
                std::thread::sleep(Duration::from_millis(5));
            }
            println!("{{\"title\":\"fixture\"}}");
            std::io::stdout().flush().unwrap();
            if mode == "fork-live" {
                std::thread::sleep(Duration::from_secs(30));
            }
        }
        "read" => {
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes).unwrap();
        }
        "exit" => {}
        _ => {
            let window = unsafe { GetConsoleWindow() };
            let name = if window.is_null() {
                "no_console"
            } else if unsafe { IsWindowVisible(window) } != 0 {
                "visible"
            } else {
                "hidden"
            };
            println!("{{\"title\":\"{name}\"}}");
        }
    }
}
