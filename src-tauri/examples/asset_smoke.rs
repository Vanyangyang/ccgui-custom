//! Smoke: verify the embedded frontendDist resolves through the same Assets
//! lookup the LAN web server uses (web.rs::load_static), so the include_dir
//! removal cannot ship an .app whose web access serves 503s.
//!
//! Must run in release so cfg(dev) is off and assets are actually embedded:
//!
//!   cargo run --release --example asset_smoke

use tauri::utils::assets::AssetKey;

fn main() {
    let ctx = tauri::generate_context!();
    let assets: &dyn tauri::Assets<tauri::Wry> = ctx.assets();

    let mut total = 0usize;
    let mut files = 0usize;
    for (_key, bytes) in assets.iter() {
        files += 1;
        total += bytes.len();
    }
    assert!(files > 0, "no embedded assets — build the frontend first");

    // Same keys web.rs serves: bare paths, no leading slash.
    let index = assets
        .get(&AssetKey::from("index.html"))
        .expect("index.html must resolve");
    let html = String::from_utf8_lossy(&index);
    assert!(html.contains("<html"), "index.html is not HTML");
    let entry = html
        .split("assets/index-")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .map(|suffix| format!("assets/index-{suffix}"))
        .expect("index.html must reference a hashed entry chunk");
    assert!(
        assets.get(&AssetKey::from(entry.as_str())).is_some(),
        "entry chunk {entry} must resolve"
    );

    println!("ok: {files} embedded assets, {total} bytes, entry chunk {entry} resolves");
}
