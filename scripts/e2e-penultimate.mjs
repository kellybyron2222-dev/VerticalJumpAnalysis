/**
 * Headless Auto on IMG_pen_small (Byron penultimate clip).
 * Expects plant ≈ TD109 TO162 LD286, height ≈25.4, plant ≈313 ms, pen ≈150, gap ≈100.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";

const log = (...args) => {
  console.log(new Date().toISOString(), ...args);
};

const ROOT = join(process.cwd(), "dist");
const VIDEO = process.env.PEN_CLIP ?? "/tmp/jumplab/IMG_pen_small.mp4";
const HEAVY = process.env.PEN_HEAVY !== "0";
if (!existsSync(VIDEO)) {
  console.error("missing clip", VIDEO);
  process.exit(2);
}
log("clip", VIDEO, "heavy", HEAVY);

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".json": "application/json",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
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
  try {
    const data = readFileSync(join(ROOT, path));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("missing");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
log("server", port);

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});
log("browser up");
const page = await browser.newPage();
page.setDefaultTimeout(120_000);
page.on("console", (msg) => {
  if (msg.type() === "error") log("CONSOLE", msg.text());
});
page.on("pageerror", (err) => log("PAGEERROR", err.message));

log("goto");
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => {
  // Force Jump Analysis screen (guide / first-visit overlays can hide it in headless).
  const guide = document.querySelector("#guide");
  const analyze = document.querySelector("#analyze");
  const box = document.querySelector("#screen-box");
  const master = document.querySelector("#screen-master");
  const profiles = document.querySelector("#screen-profiles");
  if (guide) guide.hidden = true;
  if (box) box.hidden = true;
  if (master) master.hidden = true;
  if (profiles) profiles.hidden = true;
  if (analyze) analyze.hidden = false;
  document.querySelector("#dismiss-guide")?.click();
  document.querySelector("#nav-analyze")?.click();
});
await page.waitForSelector("#analyze:not([hidden])", { timeout: 15000 });
await page.waitForSelector("#auto-detect", { state: "attached", timeout: 15000 });

log("set jump type + accuracy");
await page.evaluate((heavy) => {
  const radio = document.querySelector('#jump-type-group input[value="penultimate"]');
  if (radio) {
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    radio.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const acc = document.querySelector("#high-accuracy");
  if (acc) {
    acc.checked = !!heavy;
    acc.dispatchEvent(new Event("change", { bubbles: true }));
  }
}, HEAVY);
log("jumpType", await page.evaluate(() => ({
  jump: document.querySelector('#jump-type-group input[name="jumpType"]:checked')?.value,
  heavy: document.querySelector("#high-accuracy")?.checked,
})));

log("load clip via file input");
await page.locator("#video-input").setInputFiles(VIDEO);
await page.waitForFunction(() => {
  const total = Number(document.querySelector("#total-label")?.textContent ?? 0);
  const auto = document.querySelector("#auto-detect");
  return total >= 100 && auto && !auto.disabled;
}, null, { timeout: 120_000 });
log("clip metadata ready", await page.evaluate(() => ({
  total: document.querySelector("#total-label")?.textContent,
  fps: document.querySelector("#fps")?.value,
  stretch: document.querySelector("#slowmo")?.value,
})));

log("Starting Auto…");
await page.evaluate(() => {
  const btn = document.querySelector("#auto-detect");
  if (btn && !btn.disabled) btn.click();
  else throw new Error(`auto-detect unavailable disabled=${btn?.disabled}`);
});
const started = Date.now();
for (;;) {
  const status = await page.locator("#detect-status").innerText().catch(() => "");
  const progress = await page.locator(".detect-progress").innerText().catch(() => "");
  log("status", status.slice(0, 120), progress.slice(0, 80));
  if (
    /Auto marks set|Check marks|failed|cancelled|No plausible|Mark touchdown|Found \d+ jumps/i.test(
      status,
    ) && !/Scanning|Refining|Loading|Foot path|pose model/i.test(status)
  ) {
    // wait until not still scanning
    if (!/Scanning|Refining|Loading pose|Foot path/i.test(status)) break;
  }
  if (Date.now() - started > 480_000) {
    log("TIMEOUT");
    break;
  }
  await page.waitForTimeout(2000);
}

const report = await page.evaluate(() => {
  const num = (sel) => {
    const t = document.querySelector(sel)?.textContent ?? "";
    const m = t.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const frame = (sel) => {
    const t = document.querySelector(sel)?.textContent ?? "";
    if (/not set/i.test(t)) return null;
    const m = t.match(/\d+/);
    return m ? Number(m[0]) : null;
  };
  const notes = [
    ...(document.querySelector("#detect-status")?.textContent
      ? [document.querySelector("#detect-status").textContent]
      : []),
  ];
  const diag = document.querySelector("#detect-diagnostics, #advanced-panel, details");
  if (diag) notes.push(diag.textContent?.replace(/\s+/g, " ").trim().slice(0, 1500) ?? "");
  return {
    detect: document.querySelector("#detect-status")?.textContent ?? "",
    td: frame("#td-frame"),
    to: frame("#to-frame"),
    ld: frame("#ld-frame"),
    penTd: frame("#pen-td-frame"),
    penTo: frame("#pen-to-frame"),
    plantMs: num("#m-gct"),
    flightMs: num("#m-ft"),
    heightIn: num("#m-height"),
    rsi: num("#m-rsi"),
    penMs: num("#m-pen-gct"),
    gapMs: num("#m-step-gap"),
    fps: Number(document.querySelector("#fps")?.value ?? 0),
    stretch: Number(document.querySelector("#slowmo")?.value ?? 0),
    notes,
  };
});

log("REPORT", JSON.stringify(report, null, 2));

let failed = false;
function check(name, ok, detail) {
  if (ok) log("PASS", name, detail ?? "");
  else {
    console.error("FAIL", name, detail ?? "");
    failed = true;
  }
}

check("plant TD ~109", report.td != null && report.td >= 100 && report.td <= 120, report.td);
check("plant TO ~162", report.to != null && report.to >= 155 && report.to <= 170, report.to);
check("LD ~286", report.ld != null && report.ld >= 270 && report.ld <= 300, report.ld);
check("height ~25.4", report.heightIn != null && report.heightIn >= 22 && report.heightIn <= 28, report.heightIn);
check("plant ~313 ms", report.plantMs != null && report.plantMs >= 250 && report.plantMs <= 360, report.plantMs);
check("flight ~725", report.flightMs != null && report.flightMs >= 650 && report.flightMs <= 800, report.flightMs);
if (report.penMs != null && Number.isFinite(report.penMs)) {
  check("pen ~150 ms", report.penMs >= 120 && report.penMs <= 190, report.penMs);
  check("gap ~100 ms", report.gapMs != null && report.gapMs >= 70 && report.gapMs <= 140, report.gapMs);
} else {
  log("NOTE penultimate blank — plant must still pass");
}

await browser.close();
server.close();
if (failed) {
  log("E2E FAILED");
  process.exit(1);
}
log("E2E PASSED");
