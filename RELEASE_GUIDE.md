# Talky Release Guide

A simple step-by-step guide for releasing Talky for macOS (unsigned distribution).

---

## Overview

Since you're distributing without an Apple Developer account:
- The app will **not** be signed or notarized
- Users will see a one-time "unidentified developer" warning
- They right-click → Open, or go to System Settings → Privacy & Security → "Open Anyway"
- After that, the app works normally and auto-updates work

---

## One-Time Setup (Do This Once)

### Step 1: Generate Tauri Signing Keys

These keys let the app verify that updates are legitimate (separate from Apple signing).

1. Open Terminal on your Mac

2. Run:
   ```bash
   npx tauri signer generate -w ~/.tauri/talky.key
   ```

3. **Enter a password when prompted** - write this down, you'll need it

4. View your public key (you'll need this for the next step):
   ```bash
   cat ~/.tauri/talky.key.pub
   ```

5. Copy the entire output - it looks like:
   ```
   dW50cnVzdGVkIGNvbW1lbnQ6IG1pbm...
   ```

### Step 2: Update the Public Key in Code

Edit `src-tauri/tauri.conf.json` and find this section:

```json
"plugins": {
  "updater": {
    "pubkey": "OLD_KEY_HERE",
```

Replace `OLD_KEY_HERE` with the public key you copied in Step 1.

### Step 3: Verify the Update Endpoint

In the same file, check that the endpoint points to your GitHub repo:

```json
"endpoints": [
  "https://github.com/YOUR_USERNAME/YOUR_REPO/releases/latest/download/latest.json"
]
```

### Step 4: Add Secrets to GitHub

1. Go to your GitHub repository
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret** and add these two secrets:

| Secret Name | What to paste |
|-------------|---------------|
| `TAURI_SIGNING_PRIVATE_KEY` | The entire contents of `~/.tauri/talky.key` (run `cat ~/.tauri/talky.key` to see it) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you chose in Step 1 |

### Step 5: Push the Code Changes

Commit and push the updated `tauri.conf.json`:

```bash
git add -A
git commit -m "chore: configure release infrastructure"
git push origin main
```

---

## Releasing a New Version

Do this every time you want to release:

### Step 1: Bump the Version Number

The version appears in **three files** and must match in all of them.

**What version to use:**
- Bug fixes: 0.7.0 → 0.7.1
- New features: 0.7.0 → 0.8.0
- Major changes: 0.7.0 → 1.0.0

**Files to update:**

1. **`package.json`** (near the top):
   ```json
   "version": "0.8.0",
   ```

2. **`src-tauri/Cargo.toml`** (near the top):
   ```toml
   version = "0.8.0"
   ```

3. **`src-tauri/tauri.conf.json`**:
   ```json
   "version": "0.8.0",
   ```

### Step 2: Commit and Push

```bash
git add -A
git commit -m "chore: bump version to 0.8.0"
git push origin main
```

### Step 3: Trigger the Release Build

1. Go to your GitHub repository
2. Click the **Actions** tab
3. Click **Release** in the left sidebar
4. Click the **Run workflow** button (right side)
5. Make sure `main` is selected
6. Click **Run workflow**

### Step 4: Wait for Builds

The build takes about 10-15 minutes. You'll see two jobs:
- `build-macos` (aarch64-apple-darwin) - Apple Silicon Macs
- `build-macos` (x86_64-apple-darwin) - Intel Macs

### Step 5: Publish the Release

1. Go to your repository's **Releases** page (or click the link in Actions when done)
2. You'll see a **draft** release named `v0.8.0`
3. Click to edit it
4. Review the auto-generated release notes
5. Verify these files are attached:
   - `Talky_0.8.0_aarch64.dmg` (Apple Silicon)
   - `Talky_0.8.0_x64.dmg` (Intel)
   - `latest.json` (for auto-updates)
   - `.sig` files (signatures)
6. Click **Publish release**

---

## How Users Install

### First-Time Install

1. Download the `.dmg` from GitHub Releases
   - Apple Silicon Mac (M1/M2/M3): `Talky_x.x.x_aarch64.dmg`
   - Intel Mac: `Talky_x.x.x_x64.dmg`

2. Open the `.dmg` and drag Talky to Applications

3. **First launch only:** They'll see "Talky cannot be opened because it is from an unidentified developer"
   - Right-click (or Control-click) the app → click **Open**
   - Or: System Settings → Privacy & Security → scroll down → click **Open Anyway**

4. After that one-time step, the app opens normally

### Updates

- The app automatically checks for updates
- Users see a prompt when a new version is available
- They click to update, the app downloads and relaunches

---

## Quick Reference

### Secrets Needed (just 2)

| Secret | Where it comes from |
|--------|---------------------|
| `TAURI_SIGNING_PRIVATE_KEY` | `cat ~/.tauri/talky.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password you chose when generating |

### Files with Version Number (update all 3)

1. `package.json`
2. `src-tauri/Cargo.toml`
3. `src-tauri/tauri.conf.json`

### Release Checklist

- [ ] Bump version in 3 files
- [ ] Commit and push
- [ ] Actions → Release → Run workflow
- [ ] Wait ~15 min
- [ ] Releases → Publish draft

---

## Troubleshooting

### Build fails with "signing key" error
- Check that `TAURI_SIGNING_PRIVATE_KEY` contains the full key (including the `-----BEGIN` and `-----END` lines)
- Check that `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` matches what you entered when generating

### Auto-updates don't work
- Check that the public key in `tauri.conf.json` matches your `~/.tauri/talky.key.pub`
- Check that the endpoint URL points to your actual GitHub repo
- Make sure you published the release (not still in draft)

### Users can't open the app
- Tell them to right-click → Open on first launch
- Or: System Settings → Privacy & Security → Open Anyway
