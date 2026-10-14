import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = "/workspace/dist";
const VIDEO = "/tmp/IMG_0227_h264.mp4";
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/clip.mp4") {
    const data = readFileSync(VIDEO);
    const size = data.length;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m?.[1] ?? 0);
      const end = m?.[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
      });
      res.end(data.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
    });
    res.end(data);
    return;
  }
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(ROOT, path);
  try {
    const data = readFileSync(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("missing");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("CONSOLE", msg.text());
});
page.on("pageerror", (err) => console.log("PAGEERROR", err.message));

async function loadClip() {
  await page.locator("#video-input").setInputFiles(VIDEO);
  await page.waitForFunction(() => {
    const total = Number(document.querySelector("#total-label")?.textContent ?? 0);
    const fps = Number(document.querySelector("#fps")?.value ?? 0);
    const stretch = Number(document.querySelector("#slowmo")?.value ?? 0);
    const auto = document.querySelector("#auto-detect");
    return total >= 100 && fps > 100 && stretch === 4 && auto && !auto.disabled;
  }, null, { timeout: 60000 });
  await page.evaluate((src) => {
    const video = document.querySelector("#video");
    video.src = src;
    video.load();
  }, `http://127.0.0.1:${port}/clip.mp4`);
  await page.waitForFunction(() => {
    const video = document.querySelector("#video");
    return video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 1;
  }, null, { timeout: 60000 });
}

async function setMark(frame, button) {
  await page.evaluate((f) => {
    const scrubber = document.querySelector("#scrubber");
    scrubber.value = String(f);
    scrubber.dispatchEvent(new Event("input", { bubbles: true }));
  }, frame);
  await page.waitForTimeout(300);
  await page.click(button);
}

async function clearMarks() {
  for (const id of ["#clear-so", "#clear-td", "#clear-to", "#clear-ld"]) {
    const btn = page.locator(id);
    if (await btn.isEnabled()) await btn.click();
  }
}

async function readMetrics() {
  return page.evaluate(() => ({
    so: document.querySelector("#so-frame").textContent,
    td: document.querySelector("#td-frame").textContent,
    to: document.querySelector("#to-frame").textContent,
    ld: document.querySelector("#ld-frame").textContent,
    gct: document.querySelector("#m-gct").textContent,
    ft: document.querySelector("#m-ft").textContent,
    height: document.querySelector("#m-height").textContent,
    rsi: document.querySelector("#m-rsi").textContent,
    box: document.querySelector("#box-height").value,
    boxEstimate: document.querySelector("#box-estimate").textContent,
    warning: document.querySelector("#metrics-warning").textContent,
    stretch: document.querySelector("#slowmo").value,
    fps: document.querySelector("#fps").value,
    detect: document.querySelector("#detect-status").textContent,
    autoDisabled: document.querySelector("#auto-detect").disabled,
    duration: document.querySelector("#video").duration,
    readyState: document.querySelector("#video").readyState,
  }));
}

function parseNum(text) {
  const m = String(text).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log("PASS", name, detail ?? "");
  else {
    console.error("FAIL", name, detail ?? "");
    failed = true;
  }
}

await page.goto(`http://127.0.0.1:${port}/`);
await page.click("#dismiss-guide");
await loadClip();

const cadence = await readMetrics();
console.log("CADENCE", {
  fps: cadence.fps,
  stretch: cadence.stretch,
  autoDisabled: cadence.autoDisabled,
  readyState: cadence.readyState,
  duration: cadence.duration,
});
check("capture fps ~170", Number(cadence.fps) > 160 && Number(cadence.fps) < 180, cadence.fps);
check("stretch 4", cadence.stretch === "4", cadence.stretch);
check("auto enabled", cadence.autoDisabled === false);
check("video playable", cadence.readyState >= 2 && cadence.duration > 1, `${cadence.readyState}/${cadence.duration}`);

console.log("\n--- Marks that previously produced 231 in / 2188 ms ---");
await setMark(11, "#set-so");
await setMark(29, "#set-td");
await setMark(67, "#set-to");
await setMark(160, "#set-ld");
const phone = await readMetrics();
console.log(phone);
check("jump ~14 in (not 231)", parseNum(phone.height) > 12 && parseNum(phone.height) < 18, phone.height);
check("flight ~550 ms (not 2188)", parseNum(phone.ft) > 450 && parseNum(phone.ft) < 650, phone.ft);
check("contact ~210 ms (not 852)", parseNum(phone.gct) > 150 && parseNum(phone.gct) < 300, phone.gct);

console.log("\n--- Corrected step-off for ~6 in box ---");
await clearMarks();
await setMark(8, "#set-so");
await setMark(40, "#set-td");
await setMark(76, "#set-to");
await setMark(170, "#set-ld");
const good = await readMetrics();
console.log(good);
check("jump ~14 in", parseNum(good.height) > 12 && parseNum(good.height) < 18, good.height);
check("box ~6 in", parseNum(good.box) > 4 && parseNum(good.box) < 9, good.box);

console.log("\n--- Auto-detect on real frames ---");
await clearMarks();
await page.click("#auto-detect");
try {
  await page.waitForFunction(() => {
    const t = document.querySelector("#detect-status")?.textContent ?? "";
    return t.includes("Auto marks set") || t.includes("failed") || t.includes("cancelled");
  }, null, { timeout: 240000 });
} catch {
  check("auto-detect finished", false, "timeout");
}
const auto = await readMetrics();
console.log(auto);
if (auto.detect.includes("Auto marks set")) {
  check("auto jump sane", parseNum(auto.height) > 3 && parseNum(auto.height) < 30, auto.height);
  check("auto flight sane", parseNum(auto.ft) > 150 && parseNum(auto.ft) < 900, auto.ft);
  check("auto contact sane", parseNum(auto.gct) > 80 && parseNum(auto.gct) < 700, auto.gct);
  check("auto box sane", parseNum(auto.box) > 2 && parseNum(auto.box) < 20, auto.box);
} else {
  check("auto-detect set marks", false, auto.detect);
}

await browser.close();
server.close();
if (failed) {
  console.log("\nE2E FAILED");
  process.exit(1);
}
console.log("\nE2E PASSED");
