fn main() {
    generate_tray_translations();
    #[cfg(target_os = "macos")]
    build_coreml_sidecar();

    tauri_build::build()
}

/// Build the Swift `talky-coreml-asr` sidecar (Core ML Parakeet path via FluidAudio).
///
/// Runs `swift build -c release` in `coreml-asr/`, then copies the resulting binary
/// to `coreml-asr/bin/talky-coreml-asr-<triple>` where Tauri's `externalBin` can
/// pick it up. Always runs — `rerun-if-changed` + Swift's own build cache make
/// this near-free when Swift sources haven't changed.
#[cfg(target_os = "macos")]
fn build_coreml_sidecar() {
    use std::path::PathBuf;
    use std::process::Command;

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let pkg = manifest_dir.join("coreml-asr");
    if !pkg.join("Package.swift").exists() {
        println!("cargo:warning=coreml-asr package missing, skipping sidecar build");
        return;
    }

    println!("cargo:rerun-if-changed=coreml-asr/Package.swift");
    println!("cargo:rerun-if-changed=coreml-asr/Sources");

    let status = Command::new("swift")
        .args(["build", "-c", "release"])
        .current_dir(&pkg)
        .status()
        .expect("failed to invoke `swift build`; is the Swift toolchain installed?");
    if !status.success() {
        panic!("swift build failed for coreml-asr sidecar");
    }

    let built = pkg.join(".build/release/talky-coreml-asr");
    if !built.exists() {
        panic!("expected sidecar at {} after build", built.display());
    }

    // Tauri's externalBin convention: <name>-<target-triple>
    let triple = std::env::var("TARGET").unwrap_or_else(|_| "aarch64-apple-darwin".to_string());
    let bin_dir = pkg.join("bin");
    std::fs::create_dir_all(&bin_dir).expect("create coreml-asr/bin");
    let dest = bin_dir.join(format!("talky-coreml-asr-{}", triple));
    std::fs::copy(&built, &dest).expect("copy sidecar to externalBin destination");
}

/// Generate tray menu translations from frontend locale files.
///
/// Source of truth: src/i18n/locales/*/translation.json
/// The English "tray" section defines the struct fields.
fn generate_tray_translations() {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;

    let out_dir = std::env::var("OUT_DIR").unwrap();
    let locales_dir = Path::new("../src/i18n/locales");

    println!("cargo:rerun-if-changed=../src/i18n/locales");

    // Collect all locale translations
    let mut translations: BTreeMap<String, serde_json::Value> = BTreeMap::new();

    for entry in fs::read_dir(locales_dir).unwrap().flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let lang = path.file_name().unwrap().to_str().unwrap().to_string();
        let json_path = path.join("translation.json");

        println!("cargo:rerun-if-changed={}", json_path.display());

        let content = fs::read_to_string(&json_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();

        if let Some(tray) = parsed.get("tray").cloned() {
            translations.insert(lang, tray);
        }
    }

    // English defines the schema
    let english = translations.get("en").unwrap().as_object().unwrap();
    let fields: Vec<_> = english
        .keys()
        .map(|k| (camel_to_snake(k), k.clone()))
        .collect();

    // Generate code
    let mut out = String::from(
        "// Auto-generated from src/i18n/locales/*/translation.json - do not edit\n\n",
    );

    // Struct
    out.push_str("#[derive(Debug, Clone)]\npub struct TrayStrings {\n");
    for (rust_field, _) in &fields {
        out.push_str(&format!("    pub {rust_field}: String,\n"));
    }
    out.push_str("}\n\n");

    // Static map
    out.push_str(
        "pub static TRANSLATIONS: Lazy<HashMap<&'static str, TrayStrings>> = Lazy::new(|| {\n",
    );
    out.push_str("    let mut m = HashMap::new();\n");

    for (lang, tray) in &translations {
        out.push_str(&format!("    m.insert(\"{lang}\", TrayStrings {{\n"));
        for (rust_field, json_key) in &fields {
            let val = tray.get(json_key).and_then(|v| v.as_str()).unwrap_or("");
            out.push_str(&format!(
                "        {rust_field}: \"{}\".to_string(),\n",
                escape_string(val)
            ));
        }
        out.push_str("    });\n");
    }

    out.push_str("    m\n});\n");

    fs::write(Path::new(&out_dir).join("tray_translations.rs"), out).unwrap();

    println!(
        "cargo:warning=Generated tray translations: {} languages, {} fields",
        translations.len(),
        fields.len()
    );
}

fn camel_to_snake(s: &str) -> String {
    s.chars()
        .enumerate()
        .fold(String::new(), |mut acc, (i, c)| {
            if c.is_uppercase() && i > 0 {
                acc.push('_');
            }
            acc.push(c.to_lowercase().next().unwrap());
            acc
        })
}

fn escape_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}
