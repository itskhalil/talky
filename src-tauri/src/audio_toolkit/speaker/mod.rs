mod pcm;

pub(super) const CHUNK_SIZE: usize = 256;
pub(super) const BUFFER_SIZE: usize = CHUNK_SIZE * 256;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::{SpeakerInput, SpeakerStream};

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub use windows::{SpeakerInput, SpeakerStream};
