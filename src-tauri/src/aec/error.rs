#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    OrtError(#[from] ort::Error),

    #[error(transparent)]
    FftError(#[from] realfft::FftError),

    #[error(transparent)]
    ShapeError(#[from] ndarray::ShapeError),

    #[error("Missing output tensor: {0}")]
    MissingOutput(String),
}
