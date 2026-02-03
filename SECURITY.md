# Talky Security Report

## Executive Summary

Talky is a desktop speech-to-text application that performs **all transcription processing locally on the user's device**. Audio data is never transmitted to external servers for transcription. The only network communication occurs for:

1. **One-time model downloads** (user-initiated)
2. **Optional update checking** (can be disabled)
3. **Optional LLM-based features** (for summarization, uses user-configured endpoints)

This document provides a comprehensive security analysis for organizations evaluating Talky for use with confidential or regulated data.

---

## Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER'S LOCAL MACHINE                            │
│                                                                         │
│  ┌──────────────┐                                                       │
│  │  Microphone  │──┐                                                    │
│  └──────────────┘  │                                                    │
│                    ▼                                                    │
│  ┌──────────────┐  ┌─────────────────────────────────────────────────┐  │
│  │   Speaker    │──│           AUDIO PROCESSING PIPELINE             │  │
│  │   (macOS)    │  │  ┌─────────┐  ┌─────┐  ┌─────┐  ┌───────────┐   │  │
│  └──────────────┘  │  │Resample │→ │ AEC │→ │ VAD │→ │Accumulate │   │  │
│                    │  └─────────┘  └─────┘  └─────┘  └───────────┘   │  │
│                    └─────────────────────────────────────────────────┘  │
│                                         │                               │
│                                         ▼                               │
│                    ┌─────────────────────────────────────────────────┐  │
│                    │         LOCAL TRANSCRIPTION ENGINE              │  │
│                    │   Whisper / Parakeet / Moonshine (ONNX)         │  │
│                    │   ══════════════════════════════════════════    │  │
│                    │   Runs 100% on-device using local models        │  │
│                    └─────────────────────────────────────────────────┘  │
│                                         │                               │
│                                         ▼                               │
│                    ┌─────────────────────────────────────────────────┐  │
│                    │              LOCAL STORAGE                      │  │
│                    │   • sessions.db (SQLite - transcripts)          │  │
│                    │   • settings_store.json (preferences)           │  │
│                    └─────────────────────────────────────────────────┘  │
│                                                                         │
│  ═══════════════════════════════════════════════════════════════════   │
│   AUDIO DATA NEVER LEAVES THIS MACHINE - transcription is 100% local   │
│  ═══════════════════════════════════════════════════════════════════   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                        │
                                        │ OPTIONAL: Transcript text only
                                        │ (for summarization features)
                                        ▼
              ┌─────────────────────────────────────────────────────────┐
              │              USER-CONFIGURED LLM API                    │
              │   (OpenAI, Anthropic, Ollama, or custom endpoint)       │
              │   ════════════════════════════════════════════════      │
              │   • Summarization is optional                           │
              │   • Only receives transcript TEXT (never audio)         │
              │   • Endpoint fully controlled by user                   │
              └─────────────────────────────────────────────────────────┘
```

---

## Network Communication Inventory

The following is a **complete enumeration** of all network endpoints the application may contact:

### 1. Model Downloads

| Endpoint | `https://blob.handy.computer/*` |
|----------|--------------------------------|
| **Purpose** | Download speech-to-text models (Whisper, Parakeet, Moonshine) |
| **When Called** | Only when user explicitly clicks "Download" in model selector |
| **Data Sent** | HTTP GET request with Range header (for resume support) |
| **Data Received** | Binary model files (.bin, .tar.gz) |
| **User Control** | Manual trigger only; no automatic downloads |

**Available Models:**
- `ggml-small.bin` (487 MB)
- `whisper-medium-q4_1.bin` (492 MB)
- `ggml-large-v3-turbo.bin` (1.6 GB)
- `ggml-large-v3-q5_0.bin` (1.1 GB)
- `parakeet-v2-int8.tar.gz` (473 MB)
- `parakeet-v3-int8.tar.gz` (478 MB)
- `moonshine-base.tar.gz` (58 MB)

**Code Reference:** `src-tauri/src/managers/model.rs` (lines 75-120)

---

### 2. Update Checking

| Endpoint | `https://github.com/itskhalil/talky/releases/latest/download/latest.json` |
|----------|--------------------------------------------------------------------------|
| **Purpose** | Check for application updates |
| **When Called** | Periodically when update checking is enabled |
| **Data Sent** | HTTP GET request (no user data) |
| **Data Received** | JSON manifest with version info and download URLs |
| **User Control** | Can be disabled in Settings → General → "Check for updates" |

**Code Reference:** `tauri.conf.json` (updater configuration)

---

### 3. LLM API (Optional Summarization)

| Endpoint | User-configured (e.g., `https://api.openai.com/v1`) |
|----------|-----------------------------------------------------|
| **Purpose** | Optional transcript improvement and meeting summaries |
| **When Called** | Only when user triggers summarization |
| **Data Sent** | Transcript text, session title, user notes (NOT audio) |
| **Data Received** | Improved/summarized text |
| **User Control** | User configures endpoint; can use local LLMs (Ollama) or private endpoints |

**Supported Providers:**
- OpenAI (`https://api.openai.com/v1`)
- Anthropic (`https://api.anthropic.com/v1`)
- OpenRouter (`https://openrouter.ai/api/v1`)
- Groq (`https://api.groq.com/openai/v1`)
- Cerebras (`https://api.cerebras.ai/v1`)
- Ollama (local: `http://localhost:11434/v1`)
- Apple Intelligence (on-device, macOS ARM64 only)
- Custom (user-defined URL)

**Code Reference:** `src-tauri/src/llm_client.rs` (lines 82-128)

---

### 4. Ollama Detection

| Endpoint | `http://localhost:11434/api/tags` |
|----------|-----------------------------------|
| **Purpose** | Detect locally-running Ollama instance |
| **When Called** | When user selects Ollama as provider |
| **Data Sent** | HTTP GET request to localhost only |
| **Data Received** | List of available local models |
| **User Control** | Only triggered when Ollama provider is selected |

**Code Reference:** `src-tauri/src/commands/mod.rs` (lines 156-198)

---

## What Is NOT Transmitted

The following data **never leaves the user's device**:

| Data Type | Storage Location | Network Transmission |
|-----------|------------------|---------------------|
| Raw audio | In-memory only (not persisted) | **Never transmitted** |
| Transcripts | `{app_data}/sessions.db` | Only if summarization used |
| User settings | `{app_data}/settings_store.json` | **Never transmitted** |
| Transcription models | `{app_data}/models/` | **Never transmitted** (downloaded once) |

**Important:** Audio recordings are processed in real-time and are **not stored to disk**. Only the resulting text transcripts are persisted.

### No Telemetry or Analytics

The application contains **zero telemetry, analytics, or crash reporting**:

- No Sentry
- No PostHog
- No Mixpanel
- No Amplitude
- No Google Analytics
- No custom analytics endpoints

---

## Local Data Storage

All application data is stored locally in the platform-specific app data directory:

| Platform | Location |
|----------|----------|
| macOS | `~/Library/Application Support/com.handy.talky/` |
| Windows | `%APPDATA%\com.handy.talky\` |
| Linux | `~/.config/com.handy.talky/` |

### Storage Contents

```
{app_data}/
├── sessions.db              # SQLite database with transcripts
├── settings_store.json      # User preferences and API keys
├── models/                  # Downloaded ML models
│   ├── ggml-small.bin
│   ├── parakeet-v3-int8/
│   └── ...
└── logs/                    # Application logs
```

**Note:** Audio is processed in real-time and discarded after transcription. No audio files are stored.

---

## User Privacy Controls

### Available Controls

1. **Skip summarization** — Don't use LLM features; transcript data never leaves device
2. **Use local-only LLMs** — Ollama (self-hosted) or Apple Intelligence (on-device)
3. **Configure custom endpoint** — Route to private/self-hosted API
4. **Disable update checking** — Prevents GitHub API calls

---

## Security Verification Steps

For security auditors wishing to verify these claims:

### 1. Network Traffic Analysis

Monitor network traffic during normal operation:

```bash
# macOS - Monitor all network connections from Talky
sudo lsof -i -n -P | grep -i talky

# Or use Wireshark/Charles Proxy to inspect HTTP traffic
```

**Expected Results:**
- During transcription: **Zero network activity**
- During model download: Connections to `blob.handy.computer` only
- With post-processing enabled: Connections to user-configured endpoint only

### 2. Code Audit for Network Calls

All network communication uses the `reqwest` crate. Search for usage:

```bash
# Find all network request code
grep -rn "reqwest\|Client::new\|\.get(\|\.post(" src-tauri/src/

# Expected locations:
# - src-tauri/src/managers/model.rs (model downloads)
# - src-tauri/src/llm_client.rs (LLM API calls)
# - src-tauri/src/commands/mod.rs (Ollama check)
```

### 3. Verify No Hidden Endpoints

Search for URL patterns:

```bash
# Find all hardcoded URLs
grep -rn "https://\|http://" src-tauri/src/ --include="*.rs"

# Find all URL construction
grep -rn "format!.*http" src-tauri/src/
```

### 4. Verify No Telemetry Dependencies

Check dependencies for analytics libraries:

```bash
# Rust dependencies
grep -i "sentry\|analytics\|telemetry\|tracking" src-tauri/Cargo.toml

# JavaScript dependencies
grep -i "sentry\|analytics\|posthog\|mixpanel\|amplitude" package.json
```

---

## Request Headers

When the application makes network requests, it sends these headers:

```
User-Agent: Talky/1.0 (+https://github.com/itskhalil/talky)
Referer: https://github.com/itskhalil/talky
X-Title: Talky
Content-Type: application/json
Authorization: Bearer {user-provided-api-key}
```

No device identifiers, hardware IDs, or tracking cookies are transmitted.

---

## Technology Stack

| Component | Technology | Security Relevance |
|-----------|------------|-------------------|
| Application Framework | Tauri 2.x | Rust-based, memory-safe |
| Transcription | Whisper/Parakeet/Moonshine | Local ONNX inference |
| Audio Processing | CPAL + custom VAD | No external dependencies |
| Database | SQLite (rusqlite) | Local file-based storage |
| Settings | tauri-plugin-store | JSON file in app data |
| HTTP Client | reqwest | Used only for documented endpoints |

---

## Conclusion

Talky is architected with privacy as a core principle:

1. **Core functionality requires zero network access** — Transcription is 100% local
2. **Audio is never stored** — Processed in real-time and discarded
3. **All network communication is user-controlled** — Only to user-configured endpoints
4. **No telemetry or tracking** — Zero analytics or crash reporting
5. **Auditable codebase** — Open source with documented network paths

For organizations requiring strict data sovereignty, Talky can operate in a completely offline mode after initial model download, with optional connection only to user-specified private LLM endpoints for summarization features.

---

*Document generated: February 2026*
*Codebase version: See git commit hash*
