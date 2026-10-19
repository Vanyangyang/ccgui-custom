//! Explicit opt-in GUI fixture. Never calls the normal CCGUI startup.
fn main() {
    if let Err(error) = ccgui_next_lib::run_assistant_notices_fixture() {
        eprintln!("[assistant-notices-fixture] {error}");
        std::process::exit(2);
    }
}
