use crate::error::{ApiError, ApiResult};
use rand::Rng as _;

/// blobId and entryId are both 128-bit values in lowercase hex (PROTOCOL.md §3.3).
pub const ID_HEX_LEN: usize = 32;

/// Validates an id from a request path or body.
///
/// Ids reach the filesystem as blob path components, so this is also the
/// defence against path traversal: a string of exactly 32 lowercase hex
/// characters cannot contain a separator or a `..`.
pub fn validate_id(id: &str, what: &str) -> ApiResult<()> {
    if id.len() != ID_HEX_LEN || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(ApiError::bad_request(format!(
            "{what} must be {ID_HEX_LEN} lowercase hex characters"
        )));
    }
    Ok(())
}

/// `n` random bytes. ThreadRng is a CryptoRng seeded from the OS; adequate for
/// vault ids and KDF salts, both public values that only need uniqueness.
pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    rand::rng().fill_bytes(&mut buf);
    buf
}

pub fn random_hex(bytes: usize) -> String {
    hex::encode(random_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_lowercase_hex_of_the_right_length() {
        assert!(validate_id(&"a".repeat(32), "blobId").is_ok());
        assert!(validate_id("0123456789abcdef0123456789abcdef", "blobId").is_ok());
    }

    #[test]
    fn rejects_wrong_length() {
        assert!(validate_id(&"a".repeat(31), "blobId").is_err());
        assert!(validate_id(&"a".repeat(33), "blobId").is_err());
    }

    #[test]
    fn rejects_uppercase_so_ids_have_one_canonical_form() {
        assert!(validate_id("0123456789ABCDEF0123456789abcdef", "blobId").is_err());
    }

    #[test]
    fn rejects_path_traversal_attempts() {
        assert!(validate_id("../../etc/passwd", "blobId").is_err());
        assert!(validate_id("aaaaaaaaaaaaaa/../aaaaaaaaaaaaaa", "blobId").is_err());
    }

    #[test]
    fn random_hex_has_the_requested_width_and_varies() {
        let a = random_hex(16);
        let b = random_hex(16);
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }
}
