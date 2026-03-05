# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

**Prerequisites:** [Rust](https://rustup.rs/) (latest stable), [Node.js](https://nodejs.org/) (with npm)

```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri dev
# If cmake error on macOS:
CMAKE_POLICY_VERSION_MINIMUM=3.5 npm run tauri dev

# Build for production
npm run tauri build

# Linting and formatting (run before committing)
npm run lint              # ESLint for frontend
npm run lint:fix          # ESLint with auto-fix
npm run format            # Prettier + cargo fmt
npm run format:check      # Check formatting without changes
```

## Architecture Overview

Talky is a cross-platform desktop speech-to-text app built with Tauri 2.x (Rust backend + React/TypeScript frontend).

**Backend** (`src-tauri/src/`): Manager pattern — core logic in `managers/` (audio, transcription, session, model, history). Tauri commands in `commands/`. Audio pipeline in `audio_toolkit/`.

**Frontend** (`src/`): React + TypeScript + Tailwind. Zustand stores in `stores/`. Tauri command bindings auto-generated in `bindings.ts` (via tauri-specta).

**Key concepts:**
- A "Note" (UI) = "session" (backend) — the primary entity. Users create Notes, type freeform text, and start/stop recording within them.
- Audio pipeline: Audio → VAD → Whisper/Parakeet → Text
- Frontend → Backend via Tauri commands; Backend → Frontend via events

## Internationalization (i18n)

All user-facing strings use i18next (ESLint enforces no hardcoded strings in JSX). Translations live in `src/i18n/locales/en/translation.json`.

**Adding new text:**

1. Add key to `src/i18n/locales/en/translation.json`
2. Use in component: `const { t } = useTranslation(); t('key.path')`

## Code Style

**Private data:** The `.AI/` directory contains real meeting transcripts and eval results with real names. Never commit private data — names, meeting content, transcript excerpts — to any tracked file. The `.AI/` gitignore defaults to ignoring everything; only infrastructure files are allowlisted.

**Rust:**

- Run `cargo fmt` and `cargo clippy` before committing
- Handle errors explicitly (avoid unwrap in production)

**TypeScript/React:**

- Strict TypeScript, avoid `any` types
- Functional components with hooks
- Tailwind CSS for styling
- Path aliases: `@/` → `./src/`

## Commit Guidelines

Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`

## Debug Mode

Access debug features: `Cmd+Shift+D` (macOS) or `Ctrl+Shift+D` (Windows/Linux)

## Claude Code Build Instructions

```bash
cd src-tauri && cargo check
cd src-tauri && cargo build
cd src-tauri && cargo clippy
```

**Important:** Never change implementation plans to work around sandbox limitations. Ask the user to run blocked commands manually instead.
