use crate::config::Config;
use crate::error::{ApiError, ApiResult};
use axum::http::HeaderMap;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Resolves a bearer token to a device id.
///
/// The device id comes from the server's own config, never from the request.
/// A client cannot assert who it is, so a leaked token cannot be used to
/// attribute entries to a different device.
pub fn authenticate(config: &Config, headers: &HeaderMap) -> ApiResult<String> {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(ApiError::unauthorized)?;

    let token = header.strip_prefix("Bearer ").ok_or_else(ApiError::unauthorized)?;

    let digest = Sha256::digest(token.as_bytes());
    let presented = hex::encode(digest);

    // Compare against every device rather than short-circuiting, so timing does
    // not reveal how far down the device list a near-match sits.
    let mut matched: Option<&str> = None;
    for device in &config.devices {
        let expected = device.token_sha256.to_ascii_lowercase();
        if presented.as_bytes().ct_eq(expected.as_bytes()).into() {
            matched = Some(device.id.as_str());
        }
    }

    matched.map(str::to_owned).ok_or_else(ApiError::unauthorized)
}

pub fn token_digest(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, DeviceConfig};
    use axum::http::HeaderValue;

    fn config_with(token: &str) -> Config {
        Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            data_dir: "/tmp/unused".into(),
            limits: Default::default(),
            git: Default::default(),
            devices: vec![DeviceConfig {
                id: "macbook".into(),
                token_sha256: token_digest(token),
            }],
        }
    }

    fn headers(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(axum::http::header::AUTHORIZATION, HeaderValue::from_str(value).unwrap());
        h
    }

    #[test]
    fn accepts_a_valid_token_and_returns_the_configured_id() {
        let config = config_with("s3cret-token");
        let id = authenticate(&config, &headers("Bearer s3cret-token")).unwrap();
        assert_eq!(id, "macbook");
    }

    #[test]
    fn rejects_a_wrong_token() {
        let config = config_with("s3cret-token");
        assert!(authenticate(&config, &headers("Bearer wrong")).is_err());
    }

    #[test]
    fn rejects_a_missing_header() {
        let config = config_with("s3cret-token");
        assert!(authenticate(&config, &HeaderMap::new()).is_err());
    }

    #[test]
    fn rejects_a_bare_token_without_the_bearer_scheme() {
        let config = config_with("s3cret-token");
        assert!(authenticate(&config, &headers("s3cret-token")).is_err());
    }
}
