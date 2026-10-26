// Compiled separately by the Windows probe regression, not a real MCP server.
use std::io::{BufRead, Write};

#[link(name = "kernel32")]
extern "system" {
    fn GetConsoleWindow() -> *mut std::ffi::c_void;
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("exit") => return,
        Some("hang") => {
            std::thread::sleep(std::time::Duration::from_secs(30));
            return;
        }
        _ => {}
    }
    let window = unsafe { GetConsoleWindow() };
    let state = if window.is_null() {
        "no_console_window"
    } else {
        "console_window"
    };
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.contains("\"method\":\"initialize\"") {
            println!("{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{\"protocolVersion\":\"2025-06-18\",\"serverInfo\":{{\"name\":\"{state}\"}}}}}}");
        } else if line.contains("\"method\":\"tools/list\"") {
            println!("{{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{{\"tools\":[{{\"name\":\"fixture_tool\"}}]}}}}");
        }
        std::io::stdout().flush().unwrap();
    }
}
