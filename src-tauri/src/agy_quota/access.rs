//! Read-only access to AGY's existing access token. Never refresh or persist credentials.
use reqwest::{header::HeaderValue, Client};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;

const MAX_CREDENTIAL: usize = 64 * 1024;
const MAX_TOKEN: usize = 16 * 1024;
const MAX_RESPONSE: usize = 256 * 1024;
const QUOTA_URL: &str =
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

pub(super) struct Credential {
    token: String,
    pub fingerprint: String,
    pub expires_at: u64,
}

impl Credential {
    pub(super) fn usable(&self, now: u64) -> bool {
        self.expires_at
            .checked_sub(now)
            .is_some_and(|left| left >= 60)
    }
}

#[derive(Deserialize)]
struct StoredCredential {
    token: StoredToken,
}

#[derive(Deserialize)]
struct StoredToken {
    access_token: String,
    expiry: String,
}

fn parse(bytes: &[u8]) -> Result<Credential, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_CREDENTIAL {
        return Err("auth_invalid");
    }
    // Unknown fields (including refresh_token) are skipped by serde, never retained.
    let stored: StoredCredential = serde_json::from_slice(bytes).map_err(|_| "auth_invalid")?;
    let token = stored.token.access_token;
    if token.is_empty()
        || token.len() > MAX_TOKEN
        || token.bytes().any(|byte| byte.is_ascii_whitespace())
        || HeaderValue::from_str(&format!("Bearer {token}")).is_err()
    {
        return Err("auth_invalid");
    }
    let expires_at = super::reset_time(&stored.token.expiry).ok_or("auth_invalid")?;
    let fingerprint = format!("{:x}", Sha256::digest(token.as_bytes()));
    Ok(Credential {
        token,
        fingerprint,
        expires_at,
    })
}

#[cfg(windows)]
pub(super) fn read() -> Result<Credential, &'static str> {
    use windows::{
        core::{w, HRESULT},
        Win32::{
            Foundation::ERROR_NOT_FOUND,
            Security::Credentials::{CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC},
        },
    };
    struct Allocation(*mut CREDENTIALW);
    impl Drop for Allocation {
        fn drop(&mut self) {
            unsafe { CredFree(self.0.cast()) };
        }
    }
    let mut raw = std::ptr::null_mut();
    unsafe { CredReadW(w!("gemini:antigravity"), CRED_TYPE_GENERIC, None, &mut raw) }.map_err(
        |error| {
            if error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) {
                "auth_missing"
            } else {
                "auth_read_failed"
            }
        },
    )?;
    if raw.is_null() {
        return Err("auth_read_failed");
    }
    let allocation = Allocation(raw);
    let stored = unsafe { &*allocation.0 };
    let size = stored.CredentialBlobSize as usize;
    if size == 0 || size > MAX_CREDENTIAL || stored.CredentialBlob.is_null() {
        return Err("auth_invalid");
    }
    // The allocation remains alive until parsing finishes, including all error paths.
    parse(unsafe { std::slice::from_raw_parts(stored.CredentialBlob, size) })
}

#[cfg(not(windows))]
pub(super) fn read() -> Result<Credential, &'static str> {
    Err("unsupported_auth_platform")
}

fn client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        // The unversioned identity omits Gemini quota groups. This CLI protocol
        // identity was verified against the same native Windows login.
        .user_agent(format!(
            "antigravity/cli/1.4.7 {}/{}",
            std::env::consts::OS,
            if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "amd64"
            }
        ))
}

fn network_error(error: reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "query_timeout"
    } else {
        "query_failed"
    }
}

pub(super) async fn fetch(credential: &Credential) -> Result<serde_json::Value, &'static str> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "auth_expired")?
        .as_secs();
    if !credential.usable(now) {
        return Err("auth_expired");
    }
    let client = client_builder().build().map_err(|_| "query_failed")?;
    fetch_with_client(&client, credential, QUOTA_URL).await
}

#[cfg(test)]
pub(super) fn fixture_credential(token: &str, expires_at: u64) -> Credential {
    Credential {
        token: token.to_owned(),
        fingerprint: format!("{:x}", Sha256::digest(token.as_bytes())),
        expires_at,
    }
}

// Only production caller supplies the fixed URL above; tests use loopback fixtures.
async fn fetch_with_client(
    client: &Client,
    credential: &Credential,
    url: &str,
) -> Result<serde_json::Value, &'static str> {
    let mut response = client
        .post(url)
        .bearer_auth(&credential.token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(network_error)?;
    match response.status().as_u16() {
        401 => return Err("quota_unauthorized"),
        403 => return Err("quota_forbidden"),
        429 => return Err("quota_rate_limited"),
        200..=299 => {}
        _ => return Err("query_failed"),
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE as u64)
    {
        return Err("invalid_response");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if chunk.len() > MAX_RESPONSE.saturating_sub(bytes.len()) {
            return Err("invalid_response");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn fixture(token: &str, expiry: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"token": {
            "access_token": token, "expiry": expiry,
            "refresh_token": {"ignored": ["not even a string"]}
        }}))
        .unwrap()
    }

    fn credential() -> Credential {
        parse(&fixture("fixture-access-token", "2030-01-01T00:00:00Z")).unwrap()
    }

    #[test]
    fn credential_validity_and_expiry_are_separate() {
        let credential = credential();
        assert!(credential.usable(credential.expires_at - 60));
        assert!(!credential.usable(credential.expires_at - 59));
        assert!(!credential.usable(credential.expires_at));
        assert!(!credential.usable(u64::MAX));
        assert_eq!(credential.fingerprint.len(), 64);
        let expired = parse(&fixture("fixture", "1970-01-01T00:00:00Z")).unwrap();
        assert!(!expired.usable(1));
        let offset = parse(&fixture("fixture", "2030-01-01T08:00:00.123+08:00")).unwrap();
        assert_eq!(offset.expires_at, credential.expires_at);
    }

    #[test]
    fn credential_rejects_missing_malformed_or_unbounded_fields() {
        for bytes in [b"{}".as_slice(), b"{\"token\":{}}", b"not-json"] {
            assert!(matches!(parse(bytes), Err("auth_invalid")));
        }
        for missing in [
            serde_json::json!({"token": {"access_token": "fixture"}}),
            serde_json::json!({"token": {"expiry": "2030-01-01T00:00:00Z"}}),
        ] {
            assert!(matches!(
                parse(&serde_json::to_vec(&missing).unwrap()),
                Err("auth_invalid")
            ));
        }
        for token in ["", "a\r\nb", "a b", "\t", "\u{0}"] {
            assert!(matches!(
                parse(&fixture(token, "2030-01-01T00:00:00Z")),
                Err("auth_invalid")
            ));
        }
        assert!(parse(&fixture(&"x".repeat(MAX_TOKEN + 1), "2030-01-01T00:00:00Z")).is_err());
        assert!(parse(&vec![b' '; MAX_CREDENTIAL + 1]).is_err());
        assert!(parse(&fixture("fixture", "not-a-time")).is_err());
    }

    async fn server(response: Vec<u8>) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/quota", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0; 1024];
                let count = stream.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                if request
                    .windows(4)
                    .position(|w| w == b"\r\n\r\n")
                    .is_some_and(|end| request.len() >= end + 6)
                {
                    break;
                }
            }
            // Oversize-response tests may close the socket before all bytes are written.
            let _ = stream.write_all(&response).await;
            String::from_utf8(request).unwrap()
        });
        (url, task)
    }

    async fn request(response: Vec<u8>) -> (Result<serde_json::Value, &'static str>, String) {
        let (url, server) = server(response).await;
        // Fixtures stay on loopback even if the test host has a proxy configured.
        let client = client_builder().no_proxy().build().unwrap();
        let result = fetch_with_client(&client, &credential(), &url).await;
        (result, server.await.unwrap())
    }

    #[tokio::test]
    async fn expired_token_is_rejected_before_transport() {
        assert_eq!(
            fetch(&fixture_credential("expired-fixture", 0)).await,
            Err("auth_expired")
        );
    }

    #[tokio::test]
    async fn posts_only_quota_request() {
        let (result, request) =
            request(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".to_vec()).await;
        assert_eq!(result.unwrap(), serde_json::json!({}));
        assert!(request.starts_with("POST /quota HTTP/1.1\r\n"));
        assert!(request
            .to_ascii_lowercase()
            .contains("user-agent: antigravity/cli/1.4.7 "));
        assert!(request.contains("authorization: Bearer fixture-access-token\r\n"));
        assert!(request.ends_with("\r\n\r\n{}"));
    }

    #[tokio::test]
    async fn status_errors_and_redirect_are_bounded() {
        for (status, expected) in [
            (401, "quota_unauthorized"),
            (403, "quota_forbidden"),
            (429, "quota_rate_limited"),
            (500, "query_failed"),
        ] {
            let response = format!("HTTP/1.1 {status} Error\r\nContent-Length: 0\r\n\r\n");
            assert_eq!(request(response.into_bytes()).await.0, Err(expected));
        }
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: http://{}/redirected\r\nContent-Length: 0\r\n\r\n",
            target.local_addr().unwrap()
        );
        assert_eq!(request(response.into_bytes()).await.0, Err("query_failed"));
        assert!(
            tokio::time::timeout(Duration::from_millis(50), target.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn rejects_invalid_json_and_oversized_responses() {
        assert_eq!(
            request(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx".to_vec())
                .await
                .0,
            Err("invalid_response")
        );
        let declared = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_RESPONSE + 1
        );
        assert_eq!(
            request(declared.into_bytes()).await.0,
            Err("invalid_response")
        );
        let mut streamed = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        streamed.extend_from_slice(format!("{:x}\r\n", MAX_RESPONSE + 1).as_bytes());
        streamed.extend(std::iter::repeat_n(b' ', MAX_RESPONSE + 1));
        streamed.extend_from_slice(b"\r\n0\r\n\r\n");
        assert_eq!(request(streamed).await.0, Err("invalid_response"));
    }
}
