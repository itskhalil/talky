//! Downloads for models published as separate files (a Hugging Face repo)
//! rather than as one archive. Each file resumes on its own with a Range
//! request, and is checked by size, plus SHA-256 for the large ones.

use anyhow::{bail, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;

#[derive(Clone, Copy)]
pub struct RemoteFile {
    /// Path in the repo, appended to the base URL.
    pub remote: &'static str,
    /// Name inside the model directory.
    pub local: &'static str,
    pub size: u64,
    /// Hugging Face publishes SHA-256 for LFS files only, which covers the
    /// weights; the small text files are checked by size.
    pub sha256: Option<&'static str>,
}

/// Parakeet Ultra as a community int8 ONNX export, CC-BY-4.0. Pinned to a
/// commit so the checksums can't drift. Weight-only int8 like this is what
/// keeps Ultra's accuracy; the v3 export that quantises activations too
/// loses about a third of it.
pub const PARAKEET_ULTRA_ONNX_BASE: &str = "https://huggingface.co/Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx/resolve/3fd3b4d9772b2e595a9162f91f929f16bb4ab4cd";

pub const PARAKEET_ULTRA_ONNX_FILES: &[RemoteFile] = &[
    RemoteFile {
        remote: "config.json",
        local: "config.json",
        size: 97,
        sha256: None,
    },
    RemoteFile {
        remote: "vocab.txt",
        local: "vocab.txt",
        size: 93_939,
        sha256: None,
    },
    RemoteFile {
        remote: "nemo128.onnx",
        local: "nemo128.onnx",
        size: 139_764,
        sha256: Some("a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f"),
    },
    RemoteFile {
        remote: "int8/decoder_joint-model.int8.onnx",
        local: "decoder_joint-model.int8.onnx",
        size: 18_203_490,
        sha256: Some("f7e2db395a3b738cb2893cfb853d25863cebcc5282583a2e86b5762559e0bd32"),
    },
    RemoteFile {
        remote: "int8/encoder-model.int8.onnx",
        local: "encoder-model.int8.onnx",
        size: 649_537_325,
        sha256: Some("8a2b47169cf3f1b114010e12c0221bc6f07203289477a65a44847b9e3f1e01ed"),
    },
];

pub fn total_size(files: &[RemoteFile]) -> u64 {
    files.iter().map(|f| f.size).sum()
}

/// Download `files` into `dir`, keeping whatever is already there from an
/// earlier attempt. `progress(downloaded, total)` is called as bytes arrive.
/// A file that fails its checksum is deleted so the next attempt refetches it.
pub async fn download_files(
    client: &reqwest::Client,
    base_url: &str,
    files: &[RemoteFile],
    dir: &Path,
    mut progress: impl FnMut(u64, u64),
) -> Result<()> {
    fs::create_dir_all(dir)?;
    let total = total_size(files);
    let mut finished = 0u64;

    for f in files {
        let path = dir.join(f.local);
        let mut have = path.metadata().map(|m| m.len()).unwrap_or(0);
        if have > f.size {
            fs::remove_file(&path)?;
            have = 0;
        }

        if have < f.size {
            let mut request = client.get(format!("{base_url}/{}", f.remote));
            if have > 0 {
                request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
            }
            let response = request.send().await?;
            let status = response.status();
            let mut file = if have > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT {
                OpenOptions::new().append(true).open(&path)?
            } else if status.is_success() {
                // A 200 to a Range request is the whole file.
                have = 0;
                File::create(&path)?
            } else {
                bail!("{} returned HTTP {}", f.remote, status);
            };

            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                file.write_all(&chunk)?;
                have += chunk.len() as u64;
                progress(finished + have, total);
            }
            file.flush()?;
        }

        if have != f.size {
            bail!("{}: expected {} bytes, got {}", f.remote, f.size, have);
        }
        if let Some(expected) = f.sha256 {
            let hash_path = path.clone();
            let actual =
                tauri::async_runtime::spawn_blocking(move || sha256_file(&hash_path)).await??;
            if actual != expected {
                let _ = fs::remove_file(&path);
                bail!("{}: checksum mismatch", f.remote);
            }
        }
        finished += f.size;
        progress(finished, total);
    }
    Ok(())
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    std::io::copy(&mut File::open(path)?, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hits Hugging Face, so it's ignored by default:
    /// `cargo test --lib model_files -- --ignored`
    #[test]
    #[ignore]
    fn downloads_resumes_and_verifies_from_the_pinned_revision() {
        tauri::async_runtime::block_on(download_resume_verify());
    }

    async fn download_resume_verify() {
        let small: Vec<RemoteFile> = PARAKEET_ULTRA_ONNX_FILES
            .iter()
            .filter(|f| f.size < 1_000_000)
            .copied()
            .collect();
        let dir = std::env::temp_dir().join(format!("talky-model-files-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let client = reqwest::Client::new();

        let mut last = 0;
        download_files(
            &client,
            PARAKEET_ULTRA_ONNX_BASE,
            &small,
            &dir,
            |done, _| last = done,
        )
        .await
        .expect("fresh download");
        assert_eq!(last, total_size(&small));

        // Cut the checksummed file short: the next run must resume it with a
        // Range request and still match the hash.
        let onnx = dir.join("nemo128.onnx");
        OpenOptions::new()
            .write(true)
            .open(&onnx)
            .unwrap()
            .set_len(1000)
            .unwrap();
        download_files(&client, PARAKEET_ULTRA_ONNX_BASE, &small, &dir, |_, _| {})
            .await
            .expect("resumed download");
        assert_eq!(onnx.metadata().unwrap().len(), 139_764);

        // A wrong checksum fails and removes the file.
        let bad = [RemoteFile {
            sha256: Some("0000"),
            ..small[2]
        }];
        assert!(
            download_files(&client, PARAKEET_ULTRA_ONNX_BASE, &bad, &dir, |_, _| {})
                .await
                .is_err()
        );
        assert!(!onnx.exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
