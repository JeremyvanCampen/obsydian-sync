use anyhow::{Context, Result};
use serde::Deserialize;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct Config {
    #[serde(default = "default_bind")]
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    #[serde(default)]
    pub limits: Limits,
    #[serde(default)]
    pub git: GitConfig,
    pub devices: Vec<DeviceConfig>,
}

#[derive(Debug, Deserialize)]
pub struct DeviceConfig {
    /// Becomes the deviceId on the wire. Stable; appears in journal entries.
    pub id: String,
    /// Lowercase hex SHA-256 of the bearer token.
    ///
    /// A plain hash rather than a password KDF is correct here: these are
    /// high-entropy generated tokens, not user-chosen passwords, so there is
    /// no dictionary to attack and nothing for iteration count to buy.
    pub token_sha256: String,
}

#[derive(Debug, Deserialize)]
pub struct Limits {
    #[serde(default = "default_max_blob")]
    pub max_blob_bytes: usize,
    #[serde(default = "default_max_payload")]
    pub max_payload_bytes: usize,
    #[serde(default = "default_max_batch")]
    pub max_batch_entries: usize,
    /// Blobs written more recently than this are never collected, covering the
    /// window between a client uploading a blob and appending the journal entry
    /// that references it.
    #[serde(default = "default_gc_grace")]
    pub gc_grace_secs: u64,
}

#[derive(Debug, Default, Deserialize)]
pub struct GitConfig {
    /// Commit the data directory after writes settle. Off by default so tests
    /// and first-run setups do not require git.
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_debounce")]
    pub debounce_secs: u64,
}

fn default_bind() -> SocketAddr {
    "0.0.0.0:8787".parse().expect("valid default bind address")
}
fn default_max_blob() -> usize {
    100 * 1024 * 1024
}
fn default_max_payload() -> usize {
    64 * 1024
}
fn default_max_batch() -> usize {
    1000
}
fn default_debounce() -> u64 {
    30
}
fn default_gc_grace() -> u64 {
    24 * 60 * 60
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_blob_bytes: default_max_blob(),
            max_payload_bytes: default_max_payload(),
            max_batch_entries: default_max_batch(),
            gc_grace_secs: default_gc_grace(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading config {}", path.display()))?;
        let config: Self = toml::from_str(&text)
            .with_context(|| format!("parsing config {}", path.display()))?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<()> {
        anyhow::ensure!(!self.devices.is_empty(), "config lists no devices; nothing could authenticate");
        for d in &self.devices {
            anyhow::ensure!(
                d.token_sha256.len() == 64 && d.token_sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "device {:?}: token_sha256 must be 64 hex characters",
                d.id
            );
            anyhow::ensure!(!d.id.is_empty(), "device id must not be empty");
        }
        let mut ids: Vec<&str> = self.devices.iter().map(|d| d.id.as_str()).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        anyhow::ensure!(ids.len() == before, "duplicate device ids in config");
        Ok(())
    }
}
