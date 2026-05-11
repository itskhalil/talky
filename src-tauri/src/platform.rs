//! Platform-specific capability detection
//!
//! This module provides a way for the frontend to query which features
//! are available on the current platform.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Platform capabilities that can be queried by the frontend
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    /// Whether speaker (system audio) capture is available
    pub speaker_capture: bool,
    /// Whether meeting app detection is available
    pub meeting_detection: bool,
    /// Whether system sleep event handling is available
    pub system_sleep_events: bool,
    /// The current operating system
    pub os: String,
}

impl PlatformCapabilities {
    /// Get the capabilities for the current platform
    pub fn current() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self {
                speaker_capture: true,
                meeting_detection: true,
                system_sleep_events: true,
                os: "macos".to_string(),
            }
        }

        #[cfg(target_os = "windows")]
        {
            Self {
                speaker_capture: true,
                meeting_detection: false,   // Not yet implemented on Windows
                system_sleep_events: false, // Not yet implemented on Windows
                os: "windows".to_string(),
            }
        }

        #[cfg(target_os = "linux")]
        {
            Self {
                speaker_capture: true,
                meeting_detection: false,
                system_sleep_events: false,
                os: "linux".to_string(),
            }
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            Self {
                speaker_capture: false,
                meeting_detection: false,
                system_sleep_events: false,
                os: "unknown".to_string(),
            }
        }
    }
}

/// Tauri command to get platform capabilities
#[tauri::command]
#[specta::specta]
pub fn get_platform_capabilities() -> PlatformCapabilities {
    PlatformCapabilities::current()
}
