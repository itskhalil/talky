# Talky

**A free, open source meeting notes app with live transcription — completely offline.**
Talky is a cross-platform desktop application built with Tauri (Rust + React/TypeScript) that lets you take notes during meetings while automatically transcribing both sides of the conversation. Everything runs locally — your audio never leaves your computer.

## Why Talky?

Think [Granola](https://granola.ai) but open source and fully offline.
- **Free**: Meeting tooling belongs in everyone's hands, not behind a paywall
- **Open Source**: Together we can build further. Extend Talky for yourself and contribute to something bigger
- **Private**: Your voice stays on your computer. No cloud, no accounts, no data collection
- **Local AI**: Transcription runs on-device using Whisper or Parakeet models with GPU acceleration

## How It Works

1. **Create a Note** — open the app and start a new note
2. **Type your own notes** — jot down thoughts, agenda items, or context in the built-in editor
3. **Start recording** — hit record and Talky transcribes both your microphone and system audio (speaker) in real time
4. **Stop and resume** — pause recording whenever you want, start again within the same note
5. **Enhance with AI** — use AI to polish your notes, filling in details you missed from the transcript
6. **Chat** — ask questions about your meeting and get answers based on your notes and transcript

### Local Transcription

All transcription happens on your device:
- Mic and speaker audio are captured and transcribed separately so you can tell who said what
- Silence is filtered using VAD (Voice Activity Detection) with Silero
- Transcription uses your choice of models:
  - **Whisper models** (Small/Medium/Turbo/Large) with GPU acceleration when available
  - **Parakeet V3** — CPU-optimized model with excellent performance and automatic language detection
- Works on macOS, Windows, and Linux

### AI Features

Talky integrates with AI providers for enhanced productivity:

- **Enhanced Notes** — AI merges your rough notes with transcript details to create polished, comprehensive meeting notes. Your original notes are preserved and clearly marked alongside AI-extracted content.
- **Chat** — Ask questions about your meeting in natural language. The AI has full context of your notes and transcript to provide relevant answers.

#### Supported AI Providers

- **Cloud**: OpenAI, Anthropic, OpenRouter, Groq, Cerebras
- **Local**: Ollama, Apple Intelligence (macOS Apple Silicon)
- **Custom**: Any OpenAI-compatible endpoint

## Quick Start

### Installation

1. Download the latest release from the [releases page](https://github.com/itskhalil/talky/releases)
2. Install and launch Talky, granting microphone and system audio permissions when prompted
3. Download a transcription model (the app will guide you)
4. Create a Note and start recording

### Development Setup

For detailed build instructions including platform-specific requirements, see [BUILD.md](BUILD.md).

## Architecture

Talky is built as a Tauri application combining:

- **Frontend**: React + TypeScript with Tailwind CSS for the notes and settings UI
- **Backend**: Rust for system integration, audio processing, and ML inference
- **Core Libraries**:
  - `whisper-rs`: Local speech recognition with Whisper models
  - `transcription-rs`: CPU-optimized speech recognition with Parakeet models
  - `cpal`: Cross-platform audio I/O
  - `vad-rs`: Voice Activity Detection
  - `rdev`: Global keyboard shortcuts and system events
  - `rubato`: Audio resampling

### Debug Mode

Talky includes a debug mode for development and troubleshooting. Access it by pressing:

- **macOS**: `Cmd+Shift+D`
- **Windows/Linux**: `Ctrl+Shift+D`


### Platform Support

- **macOS (both Intel and Apple Silicon)**
- **x64 Windows**
- **x64 Linux**

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

- **Handy** by CJ Pais, which formed the audio + transcription core around which Talky was built
- **Whisper** by OpenAI for the speech recognition model
- **whisper.cpp and ggml** for amazing cross-platform whisper inference/acceleration
- **Silero** for great lightweight VAD
- **Tauri** team for the excellent Rust-based app framework
