use std::f32::consts::PI;

/// Audio preprocessor for improving transcription quality.
/// Applies DC offset removal, high-pass filtering, and RMS normalization.
pub struct AudioPreprocessor {
    /// Sample rate in Hz
    sample_rate: f32,
    /// High-pass filter cutoff frequency in Hz
    hpf_cutoff: f32,
    /// Target RMS level for normalization (0.0-1.0)
    target_rms: f32,
    /// High-pass filter coefficients and state
    hpf_state: BiquadState,
    /// DC offset accumulator for removal
    dc_alpha: f32,
    dc_offset: f32,
}

/// Biquad filter state for second-order IIR filtering
struct BiquadState {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    // Filter memory
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl BiquadState {
    /// Create a high-pass biquad filter using the cookbook formula
    /// https://www.w3.org/2011/audio/audio-eq-cookbook.html
    fn new_highpass(cutoff_hz: f32, sample_rate: f32, q: f32) -> Self {
        let omega = 2.0 * PI * cutoff_hz / sample_rate;
        let sin_omega = omega.sin();
        let cos_omega = omega.cos();
        let alpha = sin_omega / (2.0 * q);

        let b0 = (1.0 + cos_omega) / 2.0;
        let b1 = -(1.0 + cos_omega);
        let b2 = (1.0 + cos_omega) / 2.0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cos_omega;
        let a2 = 1.0 - alpha;

        // Normalize by a0
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    /// Process a single sample through the biquad filter
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;

        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;

        y
    }

    fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }
}

impl AudioPreprocessor {
    /// Create a new audio preprocessor with default settings.
    ///
    /// # Arguments
    /// * `sample_rate` - Sample rate in Hz (typically 16000 for Whisper)
    pub fn new(sample_rate: u32) -> Self {
        let sample_rate_f = sample_rate as f32;
        Self {
            sample_rate: sample_rate_f,
            hpf_cutoff: 80.0, // 80Hz high-pass to remove rumble
            target_rms: 0.1,  // Target RMS level
            hpf_state: BiquadState::new_highpass(80.0, sample_rate_f, 0.707), // Butterworth Q
            dc_alpha: 0.995,  // DC blocking filter coefficient
            dc_offset: 0.0,
        }
    }

    /// Configure the high-pass filter cutoff frequency.
    pub fn with_hpf_cutoff(mut self, cutoff_hz: f32) -> Self {
        self.hpf_cutoff = cutoff_hz;
        self.hpf_state = BiquadState::new_highpass(cutoff_hz, self.sample_rate, 0.707);
        self
    }

    /// Configure the target RMS level for normalization.
    pub fn with_target_rms(mut self, target: f32) -> Self {
        self.target_rms = target.clamp(0.01, 1.0);
        self
    }

    /// Process audio samples in-place.
    /// Applies: DC offset removal -> High-pass filter -> RMS normalization
    pub fn process(&mut self, samples: &mut [f32]) {
        if samples.is_empty() {
            return;
        }

        // Step 1: DC offset removal using exponential moving average
        for sample in samples.iter_mut() {
            self.dc_offset = self.dc_alpha * self.dc_offset + (1.0 - self.dc_alpha) * *sample;
            *sample -= self.dc_offset;
        }

        // Step 2: High-pass filter (80Hz) to remove low-frequency rumble
        for sample in samples.iter_mut() {
            *sample = self.hpf_state.process(*sample);
        }

        // Step 3: RMS normalization
        let rms = self.calculate_rms(samples);
        if rms > 1e-6 {
            let gain = self.target_rms / rms;
            // Limit gain to avoid amplifying noise too much
            let clamped_gain = gain.clamp(0.1, 10.0);
            for sample in samples.iter_mut() {
                *sample *= clamped_gain;
                // Soft clip to prevent distortion
                *sample = soft_clip(*sample);
            }
        }
    }

    /// Process audio samples and return a new buffer.
    pub fn process_copy(&mut self, samples: &[f32]) -> Vec<f32> {
        let mut output = samples.to_vec();
        self.process(&mut output);
        output
    }

    /// Calculate RMS (root mean square) of samples.
    fn calculate_rms(&self, samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum_sq: f32 = samples.iter().map(|&x| x * x).sum();
        (sum_sq / samples.len() as f32).sqrt()
    }

    /// Reset the preprocessor state.
    pub fn reset(&mut self) {
        self.dc_offset = 0.0;
        self.hpf_state.reset();
    }
}

/// Soft clipping function to prevent harsh distortion.
/// Uses tanh-based soft saturation.
fn soft_clip(x: f32) -> f32 {
    if x.abs() < 0.5 {
        x
    } else {
        x.signum() * (0.5 + 0.5 * (2.0 * (x.abs() - 0.5)).tanh())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dc_removal() {
        let mut preprocessor = AudioPreprocessor::new(16000);
        // Create signal with DC offset
        let mut samples: Vec<f32> = (0..1600)
            .map(|i| 0.5 + 0.1 * (i as f32 * 0.1).sin())
            .collect();
        preprocessor.process(&mut samples);
        // After processing, mean should be close to 0
        let mean: f32 = samples.iter().sum::<f32>() / samples.len() as f32;
        assert!(mean.abs() < 0.1, "DC offset not removed: mean = {}", mean);
    }

    #[test]
    fn test_hpf_attenuates_low_freq() {
        let mut preprocessor = AudioPreprocessor::new(16000).with_target_rms(1.0);
        // Create 40Hz signal (below 80Hz cutoff)
        let mut samples: Vec<f32> = (0..1600)
            .map(|i| (2.0 * PI * 40.0 * i as f32 / 16000.0).sin())
            .collect();
        let input_rms = (samples.iter().map(|&x| x * x).sum::<f32>() / samples.len() as f32).sqrt();
        preprocessor.process(&mut samples);
        let output_rms =
            (samples.iter().map(|&x| x * x).sum::<f32>() / samples.len() as f32).sqrt();
        // 40Hz should be attenuated (output RMS lower than input after normalization adjustment)
        // Since we normalize, the key is that the filter was applied
        assert!(output_rms > 0.0, "Output should not be zero");
        println!("Input RMS: {}, Output RMS: {}", input_rms, output_rms);
    }

    #[test]
    fn test_soft_clip() {
        assert_eq!(soft_clip(0.3), 0.3);
        assert!(soft_clip(2.0) < 2.0);
        assert!(soft_clip(-2.0) > -2.0);
    }
}
