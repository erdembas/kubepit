//! Recommendations: stored, scheduled right-sizing scans (see
//! `docs/superpowers/specs/2026-09-28-kubefit-recommendations-design.md`).
//!
//! - [`types`]: `Settings.recommendations` (which clusters scan, how often,
//!   retention, the strategy and per-strategy overrides) and the effective
//!   settings of a strategy.

pub mod types;

pub use types::*;
