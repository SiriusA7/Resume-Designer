# Electron Desktop App Guide

This document covers building, distributing, and updating the Resume Designer desktop app.

## Quick Start

```bash
# Development (web)
npm run dev

# Development (Electron with built files)
npm run electron:dev

# Development (Electron with hot reload)
npm run dev           # Terminal 1
npm run electron:start  # Terminal 2
```

## Building for Distribution

### Prerequisites

1. **App Icons** (optional but recommended)
   - Place `icon.icns` in `build/` for macOS
   - Place `icon.ico` in `build/` for Windows
   - See `build/ICONS.md` for creation instructions

2. **Code Signing** (recommended for distribution)
   - macOS: Requires Apple Developer account ($99/year)
   - Windows: Requires code signing certificate

### Build Commands

```bash
# Build for current platform
npm run electron:build

# Build for specific platforms
npm run electron:build:mac    # macOS only
npm run electron:build:win    # Windows only
npm run electron:build:all    # Both platforms

# Build and publish to GitHub Releases
npm run electron:publish
```

### Build Output

After building, find your installers in the `release/` folder:

| Platform | Files |
|----------|-------|
| macOS | `Resume Designer-1.0.0.dmg`, `Resume Designer-1.0.0-mac.zip` |
| Windows | `Resume Designer Setup 1.0.0.exe`, `Resume Designer 1.0.0.exe` (portable) |

## Distribution Options

### Option 1: GitHub Releases (Recommended)

Best for open source or small distribution:

1. **Set up GitHub repository**
   ```bash
   git init
   git remote add origin https://github.com/YOUR_USERNAME/resume-designer.git
   ```

2. **Update package.json**:
   ```json
   "publish": {
     "provider": "github",
     "owner": "SiriusA7",
     "repo": "Resume-Designer"
   }
   ```

3. **Enable CI release workflow**:
   - Workflow file: `.github/workflows/release.yml`
   - Trigger: every push to `main` (including merged PRs)
   - Output: new GitHub Release with macOS + Windows artifacts

4. **Configure repository secrets/variables**:
   - Required:
     - `GITHUB_TOKEN` (provided automatically by GitHub Actions)
   - Required workflow permission:
     - `models: read` (already declared in `.github/workflows/release.yml`)
   - Optional:
     - customize changelog categories in `.github/release.yml`

5. Users download from your GitHub Releases page

### Option 2: Direct Download (Your Website)

Host the installers on your own server:

1. Build the app: `npm run electron:build:all`
2. Upload files from `release/` to your server
3. Provide download links on your website

### Option 3: App Stores

**Mac App Store:**
- Requires Apple Developer account ($99/year)
- More complex signing and notarization process
- See: https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide

**Microsoft Store:**
- Requires Microsoft Partner account
- Convert to MSIX format
- See: https://www.electronjs.org/docs/latest/tutorial/windows-store-guide

## Auto-Updates

Auto-updates are configured to work with GitHub Releases.

### How It Works

1. App checks for updates on startup (production only)
2. If update available, user is prompted to download
3. After download, user can restart to apply update
4. Updates are signed and verified automatically

### Setting Up Auto-Updates

1. **GitHub Releases** (already configured):
   - CI creates a release on every `main` push
   - CI computes the next semantic version from commit messages:
     - `major` when commits contain `BREAKING CHANGE` or `!`
     - `minor` when commits include `feat:`
     - otherwise `patch`
   - CI builds installers and uploads updater metadata (`latest*.yml`)
   - CI first generates baseline notes using GitHub release notes + `.github/release.yml`
   - CI then attempts a GitHub Models rewrite for more user-facing notes
   - If AI rewrite fails, CI automatically falls back to baseline notes

2. **No manual version bump needed** for CI releases:
   - Workflow applies the computed version during build
   - Source files are not modified by the workflow commit-wise

### Testing Updates

To test the update flow locally:

1. Install an older release build from GitHub Releases
2. Merge a PR into `main` (or push directly to `main`)
3. Wait for `.github/workflows/release.yml` to publish the new release
4. Open the installed older app - it should detect and prompt for the update

## Code Signing

### macOS Code Signing & Notarization

Required for distributing outside the Mac App Store:

1. **Get an Apple Developer account** ($99/year)

2. **Create certificates** in Apple Developer portal:
   - "Developer ID Application" certificate
   - "Developer ID Installer" certificate (for .pkg)

3. **Set environment variables**:
   ```bash
   export CSC_LINK=path/to/your/certificate.p12
   export CSC_KEY_PASSWORD=your_certificate_password
   export APPLE_ID=your@apple.id
   export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   export APPLE_TEAM_ID=YOUR_TEAM_ID
   ```

4. **Update package.json**:
   ```json
   "mac": {
     "hardenedRuntime": true,
     "gatekeeperAssess": false,
     "entitlements": "build/entitlements.mac.plist",
     "entitlementsInherit": "build/entitlements.mac.plist"
   },
   "afterSign": "scripts/notarize.js"
   ```

### Windows Code Signing

1. **Purchase a code signing certificate** from:
   - DigiCert
   - Sectigo
   - GlobalSign

2. **Set environment variables**:
   ```bash
   export CSC_LINK=path/to/your/certificate.pfx
   export CSC_KEY_PASSWORD=your_certificate_password
   ```

## Troubleshooting

### Common Issues

**"App is damaged" on macOS**
- App is not code signed or notarized
- Users can right-click > Open to bypass (not recommended for distribution)

**Windows SmartScreen warning**
- App is not code signed
- After enough installs, reputation builds and warnings decrease

**Auto-update not working**
- Check that `publish` config in package.json is correct
- Verify release assets include `latest.yml` / `latest-mac.yml`
- Ensure release artifacts include platform installers and `.blockmap` files
- If AI notes fail, workflow falls back to baseline GitHub notes

**Build fails on Windows**
- Install Visual Studio Build Tools
- Run as Administrator if permission errors

**Build fails on macOS**
- Install Xcode Command Line Tools: `xcode-select --install`

## File Structure

```
resume-designer/
├── electron/
│   ├── main.cjs          # Main process (window, IPC, updates)
│   └── preload.cjs       # Secure bridge to renderer
├── build/
│   ├── icon.icns         # macOS icon
│   ├── icon.ico          # Windows icon
│   └── ICONS.md          # Icon creation guide
├── release/              # Built installers (git-ignored)
├── src/
│   └── native.js         # Platform abstraction layer
└── package.json          # Build configuration
```

## Useful Links

- [Electron Builder Docs](https://www.electron.build/)
- [Auto-Update Docs](https://www.electron.build/auto-update)
- [Code Signing Guide](https://www.electron.build/code-signing)
- [GitHub Releases Publishing](https://www.electron.build/configuration/publish#githuboptions)
