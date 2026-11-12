//! WoodPecker-OS privileged executor.
//!
//! The only root component Woody can talk to. It accepts typed actions from a
//! fixed catalog, holds system-level actions until a human approves them on a separate channel, and writes a hash-chained
//! audit log.

pub mod audit;
pub mod catalog;
pub mod config;
pub mod net;
pub mod selfmod;
pub mod server;
pub mod util;
pub mod web;
