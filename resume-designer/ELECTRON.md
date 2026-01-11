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

2. **Update package.json** - Replace `YOUR_GITHUB_USERNAME`:
   ```json
   "publish": {
     "provider": "github",
     "owner": "YOUR_GITHUB_USERNAME",
     "repo": "resume-designer"
   }
   ```

3. **Set GitHub Token** (for publishing):
   ```bash
   export GH_TOKEN=your_github_personal_access_token
   ```

4. **Publish a release**:
   ```bash
   npm run electron:publish
   ```

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
   - Just publish releases with `npm run electron:publish`
   - Include `latest.yml` (macOS) or `latest.yml` (Windows) - auto-generated

2. **Version Bumping**:
   ```bash
   # Update version in package.json before publishing
   npm version patch  # 1.0.0 -> 1.0.1
   npm version minor  # 1.0.0 -> 1.1.0
   npm version major  # 1.0.0 -> 2.0.0
   
   npm run electron:publish
   ```

### Testing Updates

To test the update flow locally:

1. Build version 1.0.0 and install it
2. Bump version to 1.0.1 in package.json
3. Publish 1.0.1 to GitHub Releases
4. Open the installed 1.0.0 app - it should detect the update

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
- Ensure GitHub token has `repo` scope
- Verify release assets include `latest.yml` / `latest-mac.yml`

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
