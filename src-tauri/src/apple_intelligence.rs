#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    not(feature = "skip-apple-intelligence")
))]
use std::os::raw::c_int;

#[cfg(all(
    target_os = "macos",
    target_arch = "aarch64",
    not(feature = "skip-apple-intelligence")
))]
extern "C" {
    pub fn is_apple_intelligence_available() -> c_int;
}

pub fn check_apple_intelligence_availability() -> bool {
    #[cfg(all(
        target_os = "macos",
        target_arch = "aarch64",
        not(feature = "skip-apple-intelligence")
    ))]
    {
        unsafe { is_apple_intelligence_available() == 1 }
    }

    #[cfg(any(
        not(target_os = "macos"),
        not(target_arch = "aarch64"),
        feature = "skip-apple-intelligence"
    ))]
    {
        false
    }
}
