//! Latest-release probe backing the "已是最新版本" feedback: the updater
//! plugin's `check()` returns `None` when the running build is current and
//! swallows the manifest's version/date, so the About page fetches the same
//! manifest here to tell the user which release they are already on.

use serde::Serialize;
use std::time::Duration;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestReleaseInfo {
    pub version: String,
    pub pub_date: Option<String>,
}

/// GET the first configured updater endpoint and return its version/date.
/// The endpoint URL is read from tauri.conf.json so the two never drift.
#[tauri::command]
pub async fn fetch_latest_release_info(app: AppHandle) -> Result<LatestReleaseInfo, String> {
    let endpoint = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .and_then(|endpoints| endpoints.first())
        .and_then(|endpoint| endpoint.as_str())
        .ok_or_else(|| "updater endpoint not configured".to_string())?
        .to_string();

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("build http client: {e}"))?;

    let manifest: serde_json::Value = client
        .get(&endpoint)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| format!("{endpoint}: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse update manifest: {e}"))?;

    let version = manifest
        .get("version")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "update manifest missing version".to_string())?
        .to_string();
    let pub_date = manifest
        .get("pub_date")
        .and_then(|value| value.as_str())
        .map(str::to_string);

    Ok(LatestReleaseInfo { version, pub_date })
}
