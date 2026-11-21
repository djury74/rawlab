// RGB histogram drawn from a small render of the developed image.
export function drawHistogram(canvas, pixels) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#161616';
  ctx.fillRect(0, 0, W, H);
  if (!pixels) return;
  const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    bins[0][pixels[i]]++; bins[1][pixels[i + 1]]++; bins[2][pixels[i + 2]]++; n++;
  }
  if (!n) return;
  // Scale to a high percentile so one clipped spike does not flatten the rest.
  const all = [];
  for (const b of bins) for (let i = 2; i < 254; i++) all.push(b[i]);
  all.sort((a, b) => a - b);
  const peak = Math.max(all[Math.floor(all.length * 0.995)] * 1.15, 1);
  ctx.globalCompositeOperation = 'lighter';
  const colors = ['#d8453a', '#3fae4a', '#3f7fe0'];
  bins.forEach((b, c) => {
    ctx.fillStyle = colors[c];
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) ctx.lineTo(i / 255 * W, H - Math.min(1, b[i] / peak) * (H - 4));
    ctx.lineTo(W, H); ctx.fill();
  });
  ctx.globalCompositeOperation = 'source-over';
  const clipped = (i) => bins.some((b) => b[i] / n > 0.002);
  if (clipped(0)) { ctx.fillStyle = '#5aa2ff'; ctx.fillRect(0, 0, 6, 6); }
  if (clipped(255)) { ctx.fillStyle = '#ff6b5e'; ctx.fillRect(W - 6, 0, 6, 6); }
}
