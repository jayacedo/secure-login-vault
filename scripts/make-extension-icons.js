// One-off: makes the extension's toolbar icons from the app icon.
//   node scripts/run-electron-test.js scripts/make-extension-icons.js
// (It runs inside Electron only to use its image resizing; the PNGs it writes are
// committed, so this does not need to be run again unless the app icon changes.)
const fs = require("fs");
const path = require("path");
const { app, nativeImage } = require("electron");

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icon.png"));
  if (source.isEmpty()) {
    console.error("Could not read assets/icon.png");
    app.exit(1);
    return;
  }

  const outDir = path.join(__dirname, "..", "extension", "icons");
  fs.mkdirSync(outDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const png = source.resize({ width: size, height: size, quality: "best" }).toPNG();
    fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
    console.log(`icon-${size}.png  ${png.length} bytes`);
  }
  app.exit(0);
});
