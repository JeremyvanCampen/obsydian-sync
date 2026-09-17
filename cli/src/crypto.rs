//! Client-side cryptography, Rust side.
//!
//! This must agree byte-for-byte with `plugin/src/crypto.ts`. The contract is
//! `protocol/PROTOCOL.md` §3 and the proof is `protocol/vectors.json`, which
//! both test suites assert against.
//!
//! Only the opening half is implemented with a random IV in mind: this crate
//! restores a vault, so it decrypts. `seal_with_iv` exists to prove the
//! encryption path matches the vectors, not to write production data.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use anyhow::{Context, Result, bail};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;

pub const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
#[cfg_attr(not(test), allow(dead_code, reason = "used by the cross-language vector tests"))]
const BLOB_ID_BYTES: usize = 16;

pub const INFO_CONTENT: &str = "obsydian-sync/v1/content";
pub const INFO_META: &str = "obsydian-sync/v1/meta";
pub const INFO_ID: &str = "obsydian-sync/v1/id";
pub const INFO_CHECK: &str = "obsydian-sync/v1/kdfcheck";

pub const KDF_CHECK_LITERAL: &str = "obsydian-sync-kdf-check";

/// HKDF salt: 32 zero bytes. Equivalent to `Hkdf::new(None, ..)`, written out
/// so it visibly matches what the TypeScript side passes to WebCrypto.
const HKDF_SALT: [u8; 32] = [0u8; 32];

pub type Key = [u8; 32];

#[derive(Clone)]
pub struct VaultKeys {
    pub content: Key,
    pub meta: Key,
    /// Only the vector tests and the test-store builder derive blob ids; the
    /// CLI reads ids from the journal rather than recomputing them.
    #[cfg_attr(not(test), allow(dead_code, reason = "used by tests and test fixtures"))]
    pub id: Key,
    pub check: Key,
}

pub const SUPPORTED_KDF: &str = "PBKDF2-HMAC-SHA256";

/// PBKDF2-HMAC-SHA256 over the NFC-normalized passphrase.
///
/// Normalization is not cosmetic: macOS hands back decomposed text, so without
/// it the same passphrase typed on the MacBook and on Linux derives two
/// different keys and one of them silently cannot open the vault.
pub fn derive_master_key(passphrase: &str, salt: &[u8], iterations: u32) -> Key {
    let normalized: String = passphrase.nfc().collect();
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(normalized.as_bytes(), salt, iterations, &mut out);
    out
}

/// Refuses a KDF this build does not implement.
///
/// Without it, a CLI older than a future Argon2id upgrade would derive a
/// PBKDF2 key from an Argon2id vault and tell the user their passphrase was
/// wrong — during a restore, which is the worst possible moment to be
/// misinformed about why something failed.
pub fn check_kdf_supported(alg: &str) -> Result<()> {
    anyhow::ensure!(
        alg == SUPPORTED_KDF,
        "this vault uses {alg}, which this build of obsydian-restore does not implement \
         (it knows {SUPPORTED_KDF}). Use a newer obsydian-restore."
    );
    Ok(())
}

pub fn derive_subkey(master: &Key, info: &str) -> Key {
    let hk = Hkdf::<Sha256>::new(Some(&HKDF_SALT), master);
    let mut okm = [0u8; 32];
    hk.expand(info.as_bytes(), &mut okm)
        .expect("32 bytes is a valid HKDF output length");
    okm
}

/// One key per purpose; none is reused across two of them.
pub fn derive_keys(master: &Key) -> VaultKeys {
    VaultKeys {
        content: derive_subkey(master, INFO_CONTENT),
        meta: derive_subkey(master, INFO_META),
        id: derive_subkey(master, INFO_ID),
        check: derive_subkey(master, INFO_CHECK),
    }
}

// --- associated data ------------------------------------------------------

pub fn aad_for_blob(blob_id: &str) -> String {
    format!("v1/blob|{blob_id}")
}

/// Uses entryId, not seq: seq is assigned server-side after the client has
/// already encrypted.
pub fn aad_for_journal(device_id: &str, entry_id: &str) -> String {
    format!("v1/journal|{device_id}|{entry_id}")
}

pub fn aad_for_kdf_check(vault_id: &str) -> String {
    format!("v1/kdfcheck|{vault_id}")
}

// --- sealing --------------------------------------------------------------

/// Deterministic sealing, for the test vectors and for building test stores.
/// Production encryption happens in the plugin, with a random IV per call.
#[cfg_attr(not(test), allow(dead_code, reason = "encryption lives in the plugin; this proves parity"))]
pub fn seal_with_iv(key: &Key, plaintext: &[u8], aad: &str, iv: &[u8; IV_BYTES]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key).expect("32-byte key");
    let ct = cipher
        .encrypt(Nonce::from_slice(iv), Payload { msg: plaintext, aad: aad.as_bytes() })
        .map_err(|_| anyhow::anyhow!("AES-GCM encryption failed"))?;

    let mut out = Vec::with_capacity(IV_BYTES + ct.len());
    out.extend_from_slice(iv);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// `iv || ciphertext || tag` -> plaintext, or an error if the tag or the AAD
/// does not match. A failure here is a tampered, mis-addressed, or
/// wrong-key value — never something to fall back from.
pub fn unseal(key: &Key, sealed: &[u8], aad: &str) -> Result<Vec<u8>> {
    // Strictly less-than: an empty file seals to exactly IV + tag = 28 bytes,
    // which is legal. Rejecting it would abort a restore of any vault holding
    // an empty note — the day-you-need-it failure this tool exists to prevent.
    if sealed.len() < IV_BYTES + TAG_BYTES {
        bail!("sealed value is too short to contain an IV and a tag");
    }
    let (iv, body) = sealed.split_at(IV_BYTES);
    let cipher = Aes256Gcm::new_from_slice(key).expect("32-byte key");
    cipher
        .decrypt(Nonce::from_slice(iv), Payload { msg: body, aad: aad.as_bytes() })
        .map_err(|_| anyhow::anyhow!("decryption failed: wrong key, wrong AAD, or tampered data"))
}

// --- blob identity --------------------------------------------------------

/// `HMAC-SHA256(k_id, plaintext)[0..16]`, lowercase hex.
#[cfg_attr(not(test), allow(dead_code, reason = "used by tests and test fixtures"))]
pub fn blob_id(keys: &VaultKeys, plaintext: &[u8]) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&keys.id).expect("32-byte key");
    mac.update(plaintext);
    hex::encode(&mac.finalize().into_bytes()[..BLOB_ID_BYTES])
}

// --- passphrase verification ---------------------------------------------

/// Verifies a passphrase before anything is written or restored.
pub fn verify_kdf_check(keys: &VaultKeys, vault_id: &str, kdf_check_b64: &str) -> Result<bool> {
    use base64::Engine as _;
    let sealed = base64::engine::general_purpose::STANDARD
        .decode(kdf_check_b64)
        .context("kdfCheck is not valid base64")?;

    match unseal(&keys.check, &sealed, &aad_for_kdf_check(vault_id)) {
        Ok(plain) => Ok(plain == KDF_CHECK_LITERAL.as_bytes()),
        // A wrong passphrase fails the AEAD tag. That is the expected outcome
        // of this check, not an error to propagate.
        Err(_) => Ok(false),
    }
}

#[cfg(test)]
mod vectors {
    use super::*;
    use base64::Engine as _;
    use serde_json::Value;

    const B64: base64::engine::general_purpose::GeneralPurpose =
        base64::engine::general_purpose::STANDARD;

    /// Compile-time include: if the vectors file goes missing, this fails to
    /// build rather than silently skipping the only cross-language check.
    fn vectors() -> Value {
        serde_json::from_str(include_str!("../../protocol/vectors.json"))
            .expect("vectors.json is valid JSON")
    }

    fn master_key(v: &Value) -> Key {
        let salt = B64.decode(v["kdf"]["salt"].as_str().unwrap()).unwrap();
        derive_master_key(
            v["passphrase"]["nfc"].as_str().unwrap(),
            &salt,
            v["kdf"]["iterations"].as_u64().unwrap() as u32,
        )
    }

    fn key_for(keys: &VaultKeys, role: &str) -> Key {
        match role {
            "content" => keys.content,
            "meta" => keys.meta,
            "id" => keys.id,
            "check" => keys.check,
            other => panic!("unknown key role {other}"),
        }
    }

    #[test]
    fn master_key_matches_the_typescript_implementation() {
        let v = vectors();
        assert_eq!(
            hex::encode(master_key(&v)),
            v["passphrase"]["masterKeyHex"].as_str().unwrap()
        );
    }

    #[test]
    fn nfc_and_nfd_passphrases_derive_the_same_key() {
        let v = vectors();
        let salt = B64.decode(v["kdf"]["salt"].as_str().unwrap()).unwrap();
        let iterations = v["kdf"]["iterations"].as_u64().unwrap() as u32;

        let from_nfd = derive_master_key(v["passphrase"]["nfd"].as_str().unwrap(), &salt, iterations);
        assert_eq!(
            hex::encode(from_nfd),
            v["passphrase"]["masterKeyHex"].as_str().unwrap(),
            "a passphrase typed on macOS must open a vault created on Linux"
        );
    }

    #[test]
    fn subkeys_match() {
        let v = vectors();
        let master = master_key(&v);
        let info = &v["subkeys"]["info"];

        for (info_key, expected_key) in [
            ("content", "contentHex"),
            ("meta", "metaHex"),
            ("id", "idHex"),
            ("check", "checkHex"),
        ] {
            let derived = derive_subkey(&master, info[info_key].as_str().unwrap());
            assert_eq!(
                hex::encode(derived),
                v["subkeys"][expected_key].as_str().unwrap(),
                "subkey {info_key} diverged"
            );
        }
    }

    #[test]
    fn blob_ids_match() {
        let v = vectors();
        let keys = derive_keys(&master_key(&v));

        for case in v["blobIds"]["cases"].as_array().unwrap() {
            let plaintext = B64.decode(case["plaintextB64"].as_str().unwrap()).unwrap();
            assert_eq!(
                blob_id(&keys, &plaintext),
                case["blobId"].as_str().unwrap(),
                "blobId diverged for case {}",
                case["name"]
            );
        }
    }

    #[test]
    fn sealing_reproduces_every_vector_byte_for_byte() {
        let v = vectors();
        let keys = derive_keys(&master_key(&v));

        for case in v["seal"]["cases"].as_array().unwrap() {
            let key = key_for(&keys, case["key"].as_str().unwrap());
            let plaintext = B64.decode(case["plaintextB64"].as_str().unwrap()).unwrap();
            let iv: [u8; IV_BYTES] = hex::decode(case["ivHex"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap();

            let sealed = seal_with_iv(&key, &plaintext, case["aad"].as_str().unwrap(), &iv).unwrap();
            assert_eq!(
                B64.encode(&sealed),
                case["sealedB64"].as_str().unwrap(),
                "ciphertext diverged for case {}",
                case["name"]
            );
        }
    }

    #[test]
    fn opens_every_vector_sealed_by_typescript() {
        let v = vectors();
        let keys = derive_keys(&master_key(&v));

        for case in v["seal"]["cases"].as_array().unwrap() {
            let key = key_for(&keys, case["key"].as_str().unwrap());
            let sealed = B64.decode(case["sealedB64"].as_str().unwrap()).unwrap();

            let plain = unseal(&key, &sealed, case["aad"].as_str().unwrap())
                .unwrap_or_else(|e| panic!("case {} failed to open: {e}", case["name"]));
            assert_eq!(
                B64.encode(&plain),
                case["plaintextB64"].as_str().unwrap(),
                "plaintext diverged for case {}",
                case["name"]
            );
        }
    }

    #[test]
    fn kdf_check_vector_verifies() {
        let v = vectors();
        let keys = derive_keys(&master_key(&v));
        let vault_id = v["identifiers"]["vaultId"].as_str().unwrap();

        let case = v["seal"]["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "kdfCheck")
            .unwrap();

        assert!(verify_kdf_check(&keys, vault_id, case["sealedB64"].as_str().unwrap()).unwrap());
    }

    #[test]
    fn a_wrong_passphrase_is_rejected_rather_than_corrupting_the_vault() {
        let v = vectors();
        let salt = B64.decode(v["kdf"]["salt"].as_str().unwrap()).unwrap();
        let iterations = v["kdf"]["iterations"].as_u64().unwrap() as u32;
        let vault_id = v["identifiers"]["vaultId"].as_str().unwrap();

        let case = v["seal"]["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "kdfCheck")
            .unwrap();

        let wrong = derive_keys(&derive_master_key("not the passphrase", &salt, iterations));
        assert!(!verify_kdf_check(&wrong, vault_id, case["sealedB64"].as_str().unwrap()).unwrap());
    }

    #[test]
    fn rejects_a_ciphertext_under_the_wrong_aad() {
        let v = vectors();
        let keys = derive_keys(&master_key(&v));
        let case = &v["seal"]["cases"][0];
        let sealed = B64.decode(case["sealedB64"].as_str().unwrap()).unwrap();

        assert!(
            unseal(&keys.content, &sealed, &aad_for_blob(&"f".repeat(32))).is_err(),
            "AAD binding must stop a blob being served under another id"
        );
    }

    #[test]
    fn rejects_a_tampered_ciphertext() {
        let v = vectors();
        let keys = derive_keys(&master_key(&v));
        let case = &v["seal"]["cases"][0];
        let mut sealed = B64.decode(case["sealedB64"].as_str().unwrap()).unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;

        assert!(unseal(&keys.content, &sealed, case["aad"].as_str().unwrap()).is_err());
    }

    #[test]
    fn rejects_a_value_too_short_to_hold_an_iv_and_tag() {
        let v = vectors();
        let keys = derive_keys(&master_key(&v));
        assert!(unseal(&keys.content, &[0u8; IV_BYTES], "v1/blob|x").is_err());
    }

    #[test]
    fn aad_strings_match_the_spec() {
        let v = vectors();
        let ids = &v["identifiers"];
        assert_eq!(aad_for_blob("abc"), "v1/blob|abc");
        assert_eq!(
            aad_for_journal(ids["deviceId"].as_str().unwrap(), ids["entryId"].as_str().unwrap()),
            format!(
                "v1/journal|{}|{}",
                ids["deviceId"].as_str().unwrap(),
                ids["entryId"].as_str().unwrap()
            )
        );
        assert_eq!(
            aad_for_kdf_check(ids["vaultId"].as_str().unwrap()),
            format!("v1/kdfcheck|{}", ids["vaultId"].as_str().unwrap())
        );
    }
}
