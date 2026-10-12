// ui-motion-reel QA. Run from the reel folder after rendering.
//   node qa.mjs [--video out/reel.mp4] [--every 2] [--transitions]
// Writes out/qa/: contact.png (a still every N s), seam.txt (frame 0 vs last, raw render and encoded mp4),
// transitions.png (8 frames across each state change), spectrum.png + wave.png, and summary.txt
// (seam, score loudness from out/score.wav, and the final mp4's loudness and true peak).
import puppeteer from "puppeteer-core";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const here = process.cwd();
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FF = ffmpegInstaller.path;
const qa = path.join(here, "out", "qa"); mkdirSync(qa, { recursive: true });
for (const f of readdirSync(qa)) rmSync(path.join(qa, f), { recursive: true });
const CHROME = process.env.CHROME_PATH || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
const ff = (...a) => spawnSync(FF, ["-hide_banner", ...a], { encoding: "utf8" });
const summary = [];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb", "--allow-file-access-from-files"], defaultViewport: { width: 1920, height: 1080 } });
const page = await browser.newPage();
page.on("pageerror", (e) => summary.push("PAGE ERROR: " + e.message));
await page.goto("file://" + path.join(here, arg("--scene", "index.html")), { waitUntil: "networkidle0" });
await page.evaluate(() => window.READY);
const { total, fps } = await page.evaluate(() => ({ total: window.TOTAL_FRAMES, fps: window.FPS || 60 }));
const shot = async (f, file) => { await page.evaluate((n) => window.renderFrame(n), f); await page.screenshot({ path: file, type: "png" }); };

// 1. contact sheet
const every = Number(arg("--every", 2)), frames = [];
for (let t = 0; t < total / fps; t += every) { const f = path.join(qa, `c-${String(Math.round(t * 100)).padStart(5, "0")}.png`); await shot(Math.round(t * fps), f); frames.push(f); }
const cols = 5, rows = Math.ceil(frames.length / cols);
ff("-y", "-v", "error", "-pattern_type", "glob", "-i", path.join(qa, "c-*.png"), "-vf", `scale=384:216,tile=${cols}x${rows}:padding=4:color=white`, "-frames:v", "1", path.join(qa, "contact.png"));
// 2. seam: raw frames must be identical for a perfect loop
await shot(0, path.join(qa, "seam-first.png")); await shot(total - 1, path.join(qa, "seam-last.png"));
const raw = ff("-i", path.join(qa, "seam-first.png"), "-i", path.join(qa, "seam-last.png"), "-lavfi", "ssim", "-f", "null", "-").stderr.match(/All:([\d.]+)/);
summary.push(`loop seam (raw render): SSIM ${raw ? raw[1] : "?"}  (1.000000 = seamless)`);
// 3. transition strips around each state change
if (args.includes("--transitions")) {
  const starts = await page.evaluate(() => [...new Set(window.__starts || [])]);
  let k = 0;
  for (const s of starts) for (let i = 0; i < 8; i++) await shot(Math.min(total - 1, Math.round((s - 0.05 + i * 0.075) * fps)), path.join(qa, `t-${String(k++).padStart(4, "0")}.png`));
  if (k) ff("-y", "-v", "error", "-pattern_type", "glob", "-i", path.join(qa, "t-*.png"), "-vf", `scale=320:180,tile=8x${Math.ceil(k / 8)}:padding=3:color=white`, "-frames:v", "1", path.join(qa, "transitions.png"));
}
await browser.close();
// 4. audio + encoded seam
const video = path.join(here, arg("--video", "out/reel.mp4"));
const wav = path.join(here, "out", "score.wav");
if (existsSync(wav)) {
  const loud = ff("-i", wav, "-af", "ebur128", "-f", "null", "-").stderr;
  const I = loud.match(/I:\s+(-?[\d.]+) LUFS/g), LRA = loud.match(/LRA:\s+([\d.]+) LU/g);
  summary.push(`score loudness: ${I ? I.at(-1) : "?"}, ${LRA ? LRA.at(-1) : "?"}  (aim for LRA >= 4 LU; the mux normalises to -16 LUFS)`);
  ff("-y", "-v", "error", "-i", wav, "-lavfi", "showspectrumpic=s=1600x420:legend=1:scale=log:fscale=log:color=viridis", path.join(qa, "spectrum.png"));
  ff("-y", "-v", "error", "-i", wav, "-filter_complex", "showwavespic=s=1600x200:colors=#6569d2", "-frames:v", "1", path.join(qa, "wave.png"));
}
const seam = [`raw render (frame 0 vs last): SSIM ${raw ? raw[1] : "?"}`];
if (existsSync(video)) {
  const probe = ff("-i", video).stderr.split("\n").filter((l) => /Duration|Stream/.test(l)).map((l) => l.trim());
  summary.push("video: " + probe.join(" | "));
  ff("-y", "-v", "error", "-ss", "0", "-i", video, "-frames:v", "1", path.join(qa, "enc-first.png"));
  ff("-y", "-v", "error", "-sseof", "-0.02", "-i", video, "-frames:v", "1", path.join(qa, "enc-last.png"));
  const enc = ff("-i", path.join(qa, "enc-first.png"), "-i", path.join(qa, "enc-last.png"), "-lavfi", "ssim", "-f", "null", "-").stderr.match(/All:([\d.]+)/);
  seam.push(`encoded mp4 (frame 0 vs last): SSIM ${enc ? enc[1] : "?"}  (about 0.99 is normal: keyframe vs predicted frame)`);
  summary.push(`loop seam (encoded mp4): SSIM ${enc ? enc[1] : "?"}`);
  const vl = ff("-i", video, "-af", "ebur128=peak=true", "-f", "null", "-").stderr;
  const vI = vl.match(/I:\s+(-?[\d.]+) LUFS/g), vR = vl.match(/LRA:\s+([\d.]+) LU/g), vP = vl.match(/Peak:\s+(-?[\d.]+) dBFS/g);
  if (vI) summary.push(`mp4 loudness: ${vI.at(-1)}, ${vR ? vR.at(-1) : ""}, true peak ${vP ? vP.at(-1).replace(/Peak:\s+/, "") : "?"}  (target about -16 LUFS, peak under -1 dBFS)`);
}
writeFileSync(path.join(qa, "seam.txt"), seam.join("\n") + "\n");
writeFileSync(path.join(qa, "summary.txt"), summary.join("\n") + "\n");
console.log(summary.join("\n"));
console.log("QA images in out/qa/ (contact.png" + (args.includes("--transitions") ? ", transitions.png" : "") + (existsSync(wav) ? ", spectrum.png, wave.png" : "") + ")");

process.exit(0);
