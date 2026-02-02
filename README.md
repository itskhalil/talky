# Talky

**A free, open source meeting notes app with live transcription and AI-powered note enhancement.**

Talky is a cross-platform desktop application built with Tauri (Rust + React/TypeScript) that lets you take notes during meetings while automatically transcribing both sides of the conversation. Transcription runs entirely on your device — your audio never leaves your computer. Optional AI features let you enhance your notes and chat with your transcript.

## Why Talky?

Think [Granola](https://granola.ai) but open source and private by default.
- **Free**: Meeting tooling belongs in everyone's hands, not behind a paywall
- **Open Source**: Together we can build further. Extend Talky for yourself and contribute to something bigger
- **Private**: Transcription runs entirely on your device — your audio never leaves your computer. AI features are optional and use your own API keys.
- **Local AI**: Speech-to-text runs on-device using Whisper or Parakeet models with GPU acceleration. You can also use local LLMs via Ollama or Apple Intelligence for fully offline AI.

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

- **Local**: Ollama, Apple Intelligence (macOS Apple Silicon)
- **Cloud**: OpenAI, Anthropic, OpenRouter, Groq, Cerebras (disabled by default, enable via debug pane)
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
  - `transcribe-rs`: Local speech recognition with Whisper, Parakeet, and Moonshine models
  - `cpal`: Cross-platform audio I/O
  - `vad-rs`: Voice Activity Detection
  - `rubato`: Audio resampling

### Debug Mode

Talky includes a debug pane for development, troubleshooting, and advanced settings like enabling cloud AI providers. Access it by pressing:

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
