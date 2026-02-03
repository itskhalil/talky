mod error;
mod model;

pub use error::Error;

use ndarray::{Array3, Array4};
use ort::{session::Session, value::TensorRef};
use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

struct CircularBuffer {
    buffer: Vec<f32>,
    block_len: usize,
    block_shift: usize,
}

impl CircularBuffer {
    fn new(block_len: usize, block_shift: usize) -> Self {
        Self {
            buffer: vec![0.0f32; block_len],
            block_len,
            block_shift,
        }
    }

    fn push_chunk(&mut self, chunk: &[f32]) {
        self.buffer.rotate_left(self.block_shift);
        let copy_len = chunk.len().min(self.block_shift);
        self.buffer
            [self.block_len - self.block_shift..self.block_len - self.block_shift + copy_len]
            .copy_from_slice(&chunk[..copy_len]);

        if copy_len < self.block_shift {
            self.buffer[self.block_len - self.block_shift + copy_len..].fill(0.0);
        }
    }

    fn shift_and_accumulate(&mut self, data: &[f32]) {
        self.buffer.rotate_left(self.block_shift);
        self.buffer[self.block_len - self.block_shift..].fill(0.0);

        for (i, &val) in data.iter().enumerate() {
            self.buffer[i] += val;
        }
    }

    fn data(&self) -> &[f32] {
        &self.buffer
    }

    fn clear(&mut self) {
        self.buffer.fill(0.0);
    }
}

struct ProcessingContext {
    scratch: Vec<Complex<f32>>,
    ifft_scratch: Vec<Complex<f32>>,
    in_buffer_fft: Vec<f32>,
    in_block_fft: Vec<Complex<f32>>,
    lpb_buffer_fft: Vec<f32>,
    lpb_block_fft: Vec<Complex<f32>>,
    estimated_block_vec: Vec<f32>,
    in_mag: Array3<f32>,
    lpb_mag: Array3<f32>,
    estimated_block: Array3<f32>,
    in_lpb: Array3<f32>,
}

impl ProcessingContext {
    fn new(
        block_len: usize,
        fft: &Arc<dyn RealToComplex<f32>>,
        ifft: &Arc<dyn ComplexToReal<f32>>,
    ) -> Self {
        Self {
            scratch: vec![Complex::new(0.0f32, 0.0f32); fft.get_scratch_len()],
            ifft_scratch: vec![Complex::new(0.0f32, 0.0f32); ifft.get_scratch_len()],
            in_buffer_fft: vec![0.0f32; block_len],
            in_block_fft: vec![Complex::new(0.0f32, 0.0f32); block_len / 2 + 1],
            lpb_buffer_fft: vec![0.0f32; block_len],
            lpb_block_fft: vec![Complex::new(0.0f32, 0.0f32); block_len / 2 + 1],
            estimated_block_vec: vec![0.0f32; block_len],
            in_mag: Array3::<f32>::zeros((1, 1, block_len / 2 + 1)),
            lpb_mag: Array3::<f32>::zeros((1, 1, block_len / 2 + 1)),
            estimated_block: Array3::<f32>::zeros((1, 1, block_len)),
            in_lpb: Array3::<f32>::zeros((1, 1, block_len)),
        }
    }
}

pub struct AEC {
    session_1: Session,
    session_2: Session,
    block_len: usize,
    block_shift: usize,
    fft: Arc<dyn RealToComplex<f32>>,
    ifft: Arc<dyn ComplexToReal<f32>>,
    states_1: Array4<f32>,
    states_2: Array4<f32>,
    in_buffer: CircularBuffer,
    in_buffer_lpb: CircularBuffer,
    out_buffer: CircularBuffer,
}

impl AEC {
    pub fn new() -> Result<Self, Error> {
        let (block_len, block_shift) = (model::BLOCK_SIZE, model::BLOCK_SHIFT);

        let mut fft_planner = RealFftPlanner::<f32>::new();
        let fft = fft_planner.plan_fft_forward(block_len);
        let ifft = fft_planner.plan_fft_inverse(block_len);

        let session_1 = Self::load_model(model::BYTES_1)?;
        let session_2 = Self::load_model(model::BYTES_2)?;

        Ok(AEC {
            session_1,
            session_2,
            block_len,
            block_shift,
            fft,
            ifft,
            states_1: Array4::<f32>::zeros((1, 2, model::STATE_SIZE, 2)),
            states_2: Array4::<f32>::zeros((1, 2, model::STATE_SIZE, 2)),
            in_buffer: CircularBuffer::new(block_len, block_shift),
            in_buffer_lpb: CircularBuffer::new(block_len, block_shift),
            out_buffer: CircularBuffer::new(block_len, block_shift),
        })
    }

    fn load_model(bytes: &[u8]) -> Result<Session, Error> {
        use ort::session::builder::GraphOptimizationLevel;
        Ok(Session::builder()?
            .with_intra_threads(1)?
            .with_inter_threads(1)?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .commit_from_memory(bytes)?)
    }

    pub fn reset(&mut self) {
        self.states_1 = Array4::<f32>::zeros((1, 2, model::STATE_SIZE, 2));
        self.states_2 = Array4::<f32>::zeros((1, 2, model::STATE_SIZE, 2));
        self.in_buffer.clear();
        self.in_buffer_lpb.clear();
        self.out_buffer.clear();
    }

    fn calculate_fft_magnitude(
        &self,
        input: &[f32],
        fft_buffer: &mut [f32],
        fft_result: &mut [Complex<f32>],
        scratch: &mut [Complex<f32>],
        magnitude: &mut Array3<f32>,
    ) -> Result<(), Error> {
        fft_buffer.copy_from_slice(input);
        self.fft
            .process_with_scratch(fft_buffer, fft_result, scratch)?;

        for (i, &c) in fft_result.iter().enumerate() {
            magnitude[[0, 0, i]] = c.norm();
        }

        Ok(())
    }

    fn run_model_1(
        &mut self,
        in_mag: &Array3<f32>,
        lpb_mag: &Array3<f32>,
    ) -> Result<ndarray::Array1<f32>, Error> {
        let mut outputs = self.session_1.run(ort::inputs![
            TensorRef::from_array_view(in_mag.view())?,
            TensorRef::from_array_view(self.states_1.view())?,
            TensorRef::from_array_view(lpb_mag.view())?
        ])?;

        let out_mask = outputs
            .remove("Identity")
            .ok_or_else(|| Error::MissingOutput("Identity".to_string()))?
            .try_extract_array::<f32>()?
            .view()
            .to_owned();
        let out_mask_1d = out_mask.into_shape_with_order((self.block_len / 2 + 1,))?;

        self.states_1 = outputs
            .remove("Identity_1")
            .ok_or_else(|| Error::MissingOutput("Identity_1".to_string()))?
            .try_extract_array::<f32>()?
            .view()
            .to_owned()
            .into_shape_with_order((1, 2, model::STATE_SIZE, 2))?;

        Ok(out_mask_1d)
    }

    fn run_model_2(
        &mut self,
        estimated_block: &Array3<f32>,
        in_lpb: &Array3<f32>,
    ) -> Result<ndarray::Array1<f32>, Error> {
        let mut outputs = self.session_2.run(ort::inputs![
            TensorRef::from_array_view(estimated_block.view())?,
            TensorRef::from_array_view(self.states_2.view())?,
            TensorRef::from_array_view(in_lpb.view())?
        ])?;

        let out_block = outputs
            .remove("Identity")
            .ok_or_else(|| Error::MissingOutput("Identity".into()))?
            .try_extract_array::<f32>()?
            .view()
            .to_owned();
        let out_block_1d = out_block.into_shape_with_order((self.block_len,))?;

        self.states_2 = outputs
            .remove("Identity_1")
            .ok_or_else(|| Error::MissingOutput("Identity_1".into()))?
            .try_extract_array::<f32>()?
            .view()
            .to_owned()
            .into_shape_with_order((1, 2, model::STATE_SIZE, 2))?;

        Ok(out_block_1d)
    }

    pub fn process_streaming(
        &mut self,
        mic_input: &[f32],
        lpb_input: &[f32],
    ) -> Result<Vec<f32>, Error> {
        let len_audio = mic_input.len().min(lpb_input.len());
        if len_audio == 0 {
            return Ok(vec![]);
        }

        let mic_input = &mic_input[..len_audio];
        let lpb_input = &lpb_input[..len_audio];

        self._process_internal(mic_input, lpb_input)
    }

    fn _process_internal(&mut self, audio: &[f32], lpb: &[f32]) -> Result<Vec<f32>, Error> {
        let mut out_file = vec![0.0f32; audio.len()];
        let num_blocks = audio.len() / self.block_shift;

        let mut ctx = ProcessingContext::new(self.block_len, &self.fft, &self.ifft);

        for idx in 0..num_blocks {
            let start = idx * self.block_shift;
            let end = (start + self.block_shift).min(audio.len());
            let chunk_len = end - start;

            if chunk_len > 0 {
                self.in_buffer.push_chunk(&audio[start..end]);
                self.in_buffer_lpb.push_chunk(&lpb[start..end]);
            }

            self.calculate_fft_magnitude(
                self.in_buffer.data(),
                &mut ctx.in_buffer_fft,
                &mut ctx.in_block_fft,
                &mut ctx.scratch,
                &mut ctx.in_mag,
            )?;

            self.calculate_fft_magnitude(
                self.in_buffer_lpb.data(),
                &mut ctx.lpb_buffer_fft,
                &mut ctx.lpb_block_fft,
                &mut ctx.scratch,
                &mut ctx.lpb_mag,
            )?;

            let out_mask_1d = self.run_model_1(&ctx.in_mag, &ctx.lpb_mag)?;

            for (i, c) in ctx.in_block_fft.iter_mut().enumerate() {
                *c *= out_mask_1d[i];
            }

            self.ifft.process_with_scratch(
                &mut ctx.in_block_fft,
                &mut ctx.estimated_block_vec,
                &mut ctx.ifft_scratch,
            )?;

            let norm_factor = 1.0 / self.block_len as f32;
            ctx.estimated_block_vec
                .iter_mut()
                .for_each(|x| *x *= norm_factor);

            for (i, &val) in ctx.estimated_block_vec.iter().enumerate() {
                ctx.estimated_block[[0, 0, i]] = val;
            }
            for (i, &val) in self.in_buffer_lpb.data().iter().enumerate() {
                ctx.in_lpb[[0, 0, i]] = val;
            }

            let out_block_1d = self.run_model_2(&ctx.estimated_block, &ctx.in_lpb)?;

            let out_slice = out_block_1d.as_slice().ok_or_else(|| {
                Error::ShapeError(ndarray::ShapeError::from_kind(
                    ndarray::ErrorKind::IncompatibleLayout,
                ))
            })?;
            self.out_buffer.shift_and_accumulate(out_slice);

            let out_start = idx * self.block_shift;
            let out_end = (out_start + self.block_shift).min(out_file.len());
            let out_chunk_len = out_end - out_start;
            if out_chunk_len > 0 {
                out_file[out_start..out_end]
                    .copy_from_slice(&self.out_buffer.data()[..out_chunk_len]);
            }
        }

        self.normalize_output(&mut out_file);
        Ok(out_file)
    }

    fn normalize_output(&self, output: &mut [f32]) {
        let max_val = output.iter().fold(0.0f32, |max, &x| max.max(x.abs()));
        if max_val > 1.0 {
            let scale = 0.99 / max_val;
            output.iter_mut().for_each(|x| *x *= scale);
        }
    }
}
