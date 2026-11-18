const jsQR = require('jsqr');

// Each temporary scan buffer is bounded by the validated source dimensions or
// 1200x1200, released before the next attempt, and wiped after use. The caller's
// worker timeout remains the outer bound for the complete scan and second-QR check.
function scanQr(pixels, width, height) {
  function attempt(x, y, w, h, scale = 1, contrast = false) {
    const tw = Math.round(w * scale), th = Math.round(h * scale);
    const data = new Uint8ClampedArray(tw * th * 4);
    try {
      let min = 255, max = 0;
      for (let row = 0; row < th; row++) for (let col = 0; col < tw; col++) {
        const src = ((y + Math.min(h - 1, Math.floor(row / scale))) * width + x + Math.min(w - 1, Math.floor(col / scale))) * 4;
        const dst = (row * tw + col) * 4;
        if (contrast) {
          const gray = Math.round(pixels[src] * .299 + pixels[src + 1] * .587 + pixels[src + 2] * .114);
          data[dst] = data[dst + 1] = data[dst + 2] = gray;
          min = Math.min(min, gray); max = Math.max(max, gray);
        } else { data[dst] = pixels[src]; data[dst + 1] = pixels[src + 1]; data[dst + 2] = pixels[src + 2]; }
        data[dst + 3] = 255;
      }
      if (contrast === 'local') {
        // Local contrast handles a faint QR surrounded by a bright screenshot.
        // Global min/max alone would include that background and miss the QR.
        for (let by = 0; by < th; by += 32) for (let bx = 0; bx < tw; bx += 32) {
          const bottom = Math.min(th, by + 32), right = Math.min(tw, bx + 32);
          let low = 255, high = 0;
          for (let row = by; row < bottom; row++) for (let col = bx; col < right; col++) {
            const gray = data[(row * tw + col) * 4]; low = Math.min(low, gray); high = Math.max(high, gray);
          }
          if (high <= low) continue;
          for (let row = by; row < bottom; row++) for (let col = bx; col < right; col++) {
            const i = (row * tw + col) * 4;
            data[i] = data[i + 1] = data[i + 2] = Math.round((data[i] - low) * 255 / (high - low));
          }
        }
      } else if (contrast && max > min) for (let i = 0; i < data.length; i += 4) {
        data[i] = data[i + 1] = data[i + 2] = Math.round((data[i] - min) * 255 / (max - min));
      }
      const found = jsQR(data, tw, th, { inversionAttempts: 'attemptBoth' });
      if (!found) return null;
      // Map transformed coordinates back to the original PNG for masking.
      const corners = ['topLeftCorner', 'topRightCorner', 'bottomLeftCorner', 'bottomRightCorner'];
      for (const key of corners) found.location[key] = { x: x + found.location[key].x / scale, y: y + found.location[key].y / scale };
      return found;
    } finally { data.fill(0); }
  }
  let found = attempt(0, 0, width, height);
  if (found) return found;
  found = attempt(0, 0, width, height, 1, true);
  if (found) return found;
  found = attempt(0, 0, width, height, 1, 'local');
  if (found) return found;
  if (Math.max(width, height) <= 600) {
    found = attempt(0, 0, width, height, 2, true);
    if (found) return found;
  }
  // Overlapping crops reduce distracting screenshot content without assuming
  // that the QR is centered. They do not alter the stored image.
  if (Math.min(width, height) >= 240) {
    // Keep the short side on wide/tall screenshots so crops do not cut a QR
    // almost as tall/wide as the image itself.
    const w = height / width >= 1.4 ? width : Math.ceil(width * .65);
    const h = width / height >= 1.4 ? height : Math.ceil(height * .65);
    const visited = new Set();
    for (const [x, y] of [[0, 0], [width - w, 0], [0, height - h], [width - w, height - h], [Math.floor((width - w) / 2), Math.floor((height - h) / 2)]]) {
      const key = `${x},${y}`;
      if (visited.has(key)) continue;
      visited.add(key);
      found = attempt(x, y, w, h, 1, true);
      if (found) return found;
    }
  }
  return null;
}
module.exports = { scanQr };
