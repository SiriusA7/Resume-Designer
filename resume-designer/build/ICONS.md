# App Icons Setup

To build distributable apps, you need icons in the following formats:

## Required Files

### macOS
- `icon.icns` - macOS icon bundle (required for .dmg builds)
  - Should contain multiple resolutions: 16x16, 32x32, 64x64, 128x128, 256x256, 512x512, 1024x1024

### Windows
- `icon.ico` - Windows icon file (required for .exe builds)
  - Should contain multiple resolutions: 16x16, 32x32, 48x48, 64x64, 128x128, 256x256

### Source (Optional but Recommended)
- `icon.png` - High resolution PNG (1024x1024) - can be used to generate others
- `icon.svg` - Vector version for flexibility

## How to Create Icons

### Option 1: Online Converters
1. Create a 1024x1024 PNG image
2. Use https://cloudconvert.com or https://icoconvert.com to generate:
   - `.icns` for macOS
   - `.ico` for Windows

### Option 2: Using electron-icon-builder (Recommended)
```bash
npm install --save-dev electron-icon-builder
```

Add to package.json scripts:
```json
"icons": "electron-icon-builder --input=./build/icon.png --output=./build"
```

Then run:
```bash
npm run icons
```

### Option 3: macOS Command Line
```bash
# Create iconset folder
mkdir icon.iconset

# Generate different sizes from 1024x1024 source
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png

# Convert to icns
iconutil -c icns icon.iconset -o icon.icns
```

## Icon Design Tips

For Resume Designer, consider:
- A document/page icon with creative flourishes
- Use the app's accent color (#c45c3e - terracotta/coral)
- Keep it simple and recognizable at small sizes
- Test visibility against both light and dark backgrounds

## Placeholder

Until you create custom icons, electron-builder will use default Electron icons.
The app will still build and run, just without custom branding.
