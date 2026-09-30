use crate::ids::{random_bytes, random_hex};
use anyhow::{Context, Result};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const PROTOCOL_VERSION: u32 = 1;
const DEFAULT_PBKDF2_ITERATIONS: u32 = 600_000;
const SALT_BYTES: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub alg: String,
    /// base64, 32 random bytes. Public: a salt is not a secret.
    pub salt: String,
    pub iterations: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub protocol: u32,
    pub vault_id: String,
    pub kdf: KdfParams,
    /// None until a client initializes the vault. The server cannot compute
    /// this: it requires the passphrase, which the server never holds.
    pub kdf_check: Option<String>,
}

impl Meta {
    fn generate() -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            vault_id: random_hex(16),
            kdf: KdfParams {
                alg: "PBKDF2-HMAC-SHA256".into(),
                salt: B64.encode(random_bytes(SALT_BYTES)),
                iterations: DEFAULT_PBKDF2_ITERATIONS,
            },
            kdf_check: None,
        }
    }

    fn path(data_dir: &Path) -> PathBuf {
        data_dir.join("meta.json")
    }

    /// Reads meta.json, creating it on first run.
    pub fn load_or_init(data_dir: &Path) -> Result<Self> {
        let path = Self::path(data_dir);
        if path.exists() {
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            let meta: Self = serde_json::from_str(&text)
                .with_context(|| format!("parsing {}", path.display()))?;
            anyhow::ensure!(
                meta.protocol == PROTOCOL_VERSION,
                "vault uses protocol {} but this server speaks {}",
                meta.protocol,
                PROTOCOL_VERSION
            );
            Ok(meta)
        } else {
            let meta = Self::generate();
            meta.save(data_dir)?;
            tracing::info!(vault_id = %meta.vault_id, "initialized a new vault");
            Ok(meta)
        }
    }

    /// Crash-safe write. kdfCheck can only ever be set once, so losing it to a
    /// half-written file would leave the vault permanently uninitializable
    /// while its blobs remain encrypted under a key nothing records.
    pub fn save(&self, data_dir: &Path) -> Result<()> {
        use std::io::Write as _;

        let path = Self::path(data_dir);
        let tmp = path.with_extension("json.tmp");

        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&serde_json::to_vec_pretty(self)?)?;
        file.sync_all()?;
        drop(file);

        std::fs::rename(&tmp, &path)?;

        // fsync the directory so the rename itself survives a power loss.
        if let Ok(dir) = std::fs::File::open(data_dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    }
}
