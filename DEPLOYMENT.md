# Deployment Instructions

## ⚠️ CRITICAL: Do Not Copy `node_modules`

When moving your bot to a Linux server (like Pterodactyl), **NEVER** copy the `node_modules` folder from your Windows computer.

Windows and Linux use different binary files for libraries like `sharp` and `ffmpeg`. If you copy the Windows versions to Linux, the bot will crash with errors like:
> `Could not load the "sharp" module using the linux-x64 runtime`

## Correct Deployment Steps

1.  **Upload Files**: Upload only your source code (`src`, `package.json`, `bun.lockb` or `package-lock.json`, `tsconfig.json`, etc.).
    *   ❌ **EXCLUDE**: `node_modules`
    *   ❌ **EXCLUDE**: `.env` (Create this manually on the server or use the panel's variable system)

2.  **Install Dependencies**:
    On the server console (or via the Startup command), run:
    ```bash
    bun install
    ```
    *This will download the correct Linux versions of all packages.*

3.  **Start the Bot**:
    ```bash
    bun run start
    ```

## Troubleshooting

### `sharp` Module Errors
If you see `Could not load the "sharp" module`, it means you have the wrong platform binaries.
1. Delete `node_modules` and `bun.lockb`.
2. Run `bun install`.

### `ffmpeg` Errors (ENOENT)
If you see `ENOENT: no such file or directory` for `ffmpeg`, it means `ffmpeg-static` is trying to use a binary that doesn't exist (likely a Windows path on Linux).
1. **DO NOT COPY** `node_modules` from Windows.
2. Run `bun install` on the Linux server to download the correct `ffmpeg` binary.
