#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    OrtError(#[from] ort::Error),

    /// `ort` 2.0.0-rc.12 parameterised `Error` by the builder that produced it,
    /// so `SessionBuilder` failures no longer coerce into the plain `ort::Error`.
    #[error(transparent)]
    OrtSessionBuilderError(#[from] ort::Error<ort::session::builder::SessionBuilder>),

    #[error(transparent)]
    FftError(#[from] realfft::FftError),

    #[error(transparent)]
    ShapeError(#[from] ndarray::ShapeError),

    #[error("Missing output tensor: {0}")]
    MissingOutput(String),
}
