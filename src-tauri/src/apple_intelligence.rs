use std::os::raw::c_int;

extern "C" {
    pub fn is_apple_intelligence_available() -> c_int;
}

pub fn check_apple_intelligence_availability() -> bool {
    unsafe { is_apple_intelligence_available() == 1 }
}
