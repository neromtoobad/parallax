// ui-motion-reel renderer. Run from the reel folder (where index.html, reel.js, score.js live).
//   node render.mjs --stills 0,1.5,6.2          -> out/still-<t>.png (for review)
//   node render.mjs --audio                     -> out/score.wav
//   node render.mjs --mp4 [--with-audio] [--workers 6] [--out reel.mp4] [--from 0 --to 60] [--scene index.html]
// Frames are pure functions of the frame index, so workers render slices in parallel and the
// segments are joined losslessly.
import puppeteer from "puppeteer-core";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const here = process.cwd();
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const scene = path.resolve(here, arg("--scene", "index.html"));
const out = path.join(here, "out");
mkdirSync(out, { recursive: true });
const FF = ffmpegInstaller.path;
try { chmodSync(FF, 0o755); } catch {}
const CHROME = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p));
if (!CHROME) throw new Error("Chrome not found; set CHROME_PATH");

async function openPage() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none", "--allow-file-access-from-files"],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => (m.type() === "warn" || m.type() === "error") && console.log("[page]", m.text()));
  await page.goto("file://" + scene, { waitUntil: "networkidle0" });
  await page.evaluate(() => window.READY);
  const info = await page.evaluate(() => ({ total: window.TOTAL_FRAMES, fps: window.FPS || 60 }));
  return { browser, page, ...info };
}
async function shot(page, f) {
  await page.evaluate((n) => window.renderFrame(n), f);
  return page.screenshot({ type: "png", optimizeForSpeed: true });
}

if (args.includes("--audio")) {
  const { browser, page } = await openPage();
  const res = await page.evaluate(() => window.renderAudio());
  writeFileSync(path.join(out, "score.wav"), Buffer.from(res.wav, "base64"));
  console.log("out/score.wav written (pre-normalise peak " + res.peak.toFixed(3) + ")");
  await browser.close();
} else if (args.includes("--stills")) {
  const { browser, page, fps } = await openPage();
  for (const t of arg("--stills", "0").split(",").map(Number)) writeFileSync(path.join(out, `still-${t.toFixed(2)}.png`), await shot(page, Math.round(t * fps)));
  console.log("stills written to out/");
  await browser.close();
} else if (args.includes("--mp4")) {
  const workers = Number(arg("--workers", Math.max(2, Math.min(8, os.cpus().length - 2))));
  const file = path.join(out, arg("--out", "reel.mp4"));
  const started = Date.now();
  const probe = await openPage();
  const fps = probe.fps, from = Math.round(Number(arg("--from", 0)) * fps), to = Math.min(probe.total, Math.round(Number(arg("--to", 1e9)) * fps));
  await probe.browser.close();
  const span = Math.ceil((to - from) / workers), segs = [];
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const a = from + w * span, b = Math.min(to, a + span);
    if (a >= b) return;
    const seg = path.join(out, `seg-${w}.mp4`); segs[w] = seg;
    const { browser, page } = await openPage();
    const ff = spawn(FF, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
      "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.2", "-r", String(fps), "-g", String(fps * 2), seg], { stdio: ["pipe", "inherit", "inherit"] });
    for (let f = a; f < b; f++) {
      const buf = await shot(page, f);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
      if ((f - a) % 300 === 0) console.log(`w${w} ${f - a}/${b - a}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end(); await new Promise((r) => ff.on("close", r)); await browser.close();
  }));
  const list = path.join(out, "segs.txt");
  writeFileSync(list, segs.filter(Boolean).map((s) => `file '${s}'`).join("\n"));
  const score = path.join(out, "score.wav");
  const withAudio = args.includes("--with-audio") && existsSync(score);
  const cat = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list];
  if (withAudio) cat.push("-i", score, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-shortest");
  else cat.push("-c", "copy");
  cat.push("-movflags", "+faststart", file);
  await new Promise((r) => spawn(FF, cat, { stdio: "inherit" }).on("close", r));
  segs.forEach((s) => s && rmSync(s)); rmSync(list);
  console.log(`wrote ${path.relative(here, file)} in ${((Date.now() - started) / 1000).toFixed(0)}s${withAudio ? " (with score)" : ""}`);
} else {
  console.log("usage: node render.mjs --stills 0,1.5 | --audio | --mp4 [--with-audio] [--workers N] [--out file.mp4]");
}

process.exit(0);
