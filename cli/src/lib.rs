//! Decryption and vault-store reading for `obsydian-restore`.
//!
//! Exposed as a library so the integration tests can build a store the way the
//! server would have written one, using exactly the code that reads it back.

pub mod crypto;
pub mod store;
