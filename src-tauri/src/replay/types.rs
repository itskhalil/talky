use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReplaySegment {
    pub text: String,
    pub source: String,
    pub start_ms: i64,
    pub end_ms: i64,
    /// When the segment was produced, if that differs from `end_ms`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emitted_ms: Option<i64>,
}
