use super::*;
use axum::http::{HeaderMap, HeaderValue};

#[test]
fn request_reapproval_same_millisecond_and_disconnect_invalidate_original_context() {
    let db = crate::db::Db::open_at(Path::new(":memory:")).unwrap();
    db.web_device_touch("a", "synthetic", 1).unwrap();
    let unapproved = RequestContext::from_handshake(&db, "a".into(), true);
    assert!(!unapproved.authorized(&db, false));
    db.web_device_approve("a", 2).unwrap();
    assert!(!unapproved.authorized(&db, true));
    let original = RequestContext::from_handshake(&db, "a".into(), true);
    assert!(original.authorized(&db, true));
    db.web_device_revoke("a").unwrap();
    db.web_device_touch("a", "synthetic", 2).unwrap();
    db.web_device_approve("a", 2).unwrap();
    assert!(!original.authorized(&db, false));
    let fresh = RequestContext::from_handshake(&db, "a".into(), true);
    assert!(fresh.authorized(&db, true));
    let lease = SocketContextLease(fresh.clone());
    drop(lease);
    assert!(!fresh.authorized(&db, true));
    assert!(
        serde_json::to_value(db.web_device_get("a").unwrap().unwrap())
            .unwrap()
            .get("approvalGeneration")
            .is_none()
    );
}

#[test]
fn request_origin_requires_real_header_host_and_relay_tcp_provenance() {
    let peer: SocketAddr = "127.0.0.1:43123".parse().unwrap();
    let allowed = vec!["http://127.0.0.1:5329".into()];
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:5329"));
    assert!(!handshake_origin(&headers, peer, &allowed));
    for origin in [
        "null",
        "https://evil.invalid",
        "http://127.0.0.1:5329/",
        "http://user@127.0.0.1:5329",
    ] {
        headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        assert!(!handshake_origin(&headers, peer, &allowed), "{origin}");
    }
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("http://127.0.0.1:5329"),
    );
    assert!(handshake_origin(&headers, peer, &allowed));
    headers.append(
        header::ORIGIN,
        HeaderValue::from_static("http://127.0.0.1:5329"),
    );
    assert!(!handshake_origin(&headers, peer, &allowed));
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("https://relay.example"),
    );
    headers.insert("x-ccgui-via", HeaderValue::from_static("relay"));
    assert!(!handshake_origin(&headers, peer, &allowed));
    let lease = register_relay_origin(peer, "https://relay.example".into());
    assert!(handshake_origin(&headers, peer, &allowed));
    assert!(!handshake_origin(
        &headers,
        "127.0.0.1:43124".parse().unwrap(),
        &allowed
    ));
    drop(lease);
    assert!(!handshake_origin(&headers, peer, &allowed));
}

#[test]
fn request_legacy_missing_origin_is_read_only() {
    let db = crate::db::Db::open_at(Path::new(":memory:")).unwrap();
    db.web_device_touch("a", "synthetic", 1).unwrap();
    db.web_device_approve("a", 2).unwrap();
    let legacy = RequestContext::from_handshake(&db, "a".into(), false);
    assert!(legacy.authorized(&db, false));
    assert!(!legacy.authorized(&db, true));
    let anonymous = RequestContext::from_handshake(&db, String::new(), true);
    assert!(!anonymous.authorized(&db, false));
}
