/**
 * Drop GT harness: Auto-detect fixtures/drop/clip*_small.mp4 as drop jumps.
 * Gates: TD/TO/LD ±3 fr, contact/flight ±25 ms, height ±1.0 in.
 *
 * Usage: node tests/drop_gt/run.mjs
 * Env: DROP_HEAVY=0 for lite (default lite), DROP_CLIPS=clip6
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = join(process.cwd(), "dist");
const FIX = join(process.cwd(), "fixtures/drop");
const GT = JSON.parse(readFileSync(join(FIX, "ground_truth.json"), "utf8"));
const HEAVY = process.env.DROP_HEAVY === "1";
const CLIPS = (process.env.DROP_CLIPS ?? "clip6")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
  if (url.pathname.startsWith("/clip/")) {
    const name = decodeURIComponent(url.pathname.slice("/clip/".length));
    const file = join(FIX, name);
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end("missing clip");
      return;
    }
    const data = readFileSync(file);
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(data.length),
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

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log("Drop GT harness", port, "heavy", HEAVY);
console.log("clips:", readdirSync(FIX).filter((f) => f.endsWith(".mp4")).join(", "));

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});
const page = await browser.newPage();
page.setDefaultTimeout(180_000);

async function runClip(id) {
  const file = `${id}_small.mp4`;
  const path = join(FIX, file);
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const truth = GT[id];
  if (!truth?.frames) throw new Error(`no GT for ${id}`);

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(
      ".screen, #guide, #screen-box, #screen-master, #screen-profiles",
    )) {
      el.hidden = true;
    }
    const analyze = document.querySelector("#analyze");
    if (analyze) analyze.hidden = false;
  });
  await page.evaluate((heavy) => {
    const radio = document.querySelector('#jump-type-group input[value="drop"]');
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const box = document.querySelector("#box-height");
    if (box) {
      box.value = "6";
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const acc = document.querySelector("#high-accuracy");
    if (acc) {
      acc.checked = !!heavy;
      acc.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, HEAVY);

  await page.locator("#video-input").setInputFiles(path);
  await page.waitForFunction(() => {
    const total = Number(document.querySelector("#total-label")?.textContent ?? 0);
    const auto = document.querySelector("#auto-detect");
    return total >= 50 && auto && !auto.disabled;
  }, null, { timeout: 120_000 });

  await page.evaluate((src) => {
    const video = document.querySelector("#video");
    video.src = src;
    video.load();
  }, `http://127.0.0.1:${port}/clip/${file}`);
  await page.waitForFunction(() => {
    const v = document.querySelector("#video");
    return v && v.readyState >= 2 && v.duration > 1;
  }, null, { timeout: 60_000 });

  await page.evaluate(() => {
    const btn = document.querySelector("#auto-detect");
    if (!btn || btn.disabled) throw new Error("auto-detect unavailable");
    btn.click();
  });

  const started = Date.now();
  for (;;) {
    const status = await page.locator("#detect-status").innerText().catch(() => "");
    if (
      /Auto marks set|Check marks flagged|failed|cancelled|No plausible|Mark touchdown/i.test(status) &&
      !/Scanning|Refining|Loading|Foot path|pose model/i.test(status)
    ) {
      break;
    }
    if (Date.now() - started > 480_000) throw new Error(`${id} detect timeout: ${status}`);
    await page.waitForTimeout(2000);
  }

  const det = await page.evaluate(() => {
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
    return {
      status: document.querySelector("#detect-status")?.textContent ?? "",
      check: document.querySelector("#check-marks-flag")?.textContent ?? "",
      td: frame("#td-frame"),
      to: frame("#to-frame"),
      ld: frame("#ld-frame"),
      gctMs: num("#m-gct"),
      flightMs: num("#m-ft"),
      heightIn: num("#m-height"),
    };
  });

  const t = truth.frames;
  const m = truth.metrics;
  const checks = [
    ["TD ±3", det.td != null && Math.abs(det.td - t.td) <= 3, `${det.td} vs ${t.td}`],
    ["TO ±3", det.to != null && Math.abs(det.to - t.to) <= 3, `${det.to} vs ${t.to}`],
    ["LD ±3", det.ld != null && Math.abs(det.ld - t.landing) <= 3, `${det.ld} vs ${t.landing}`],
    [
      "contact ±25",
      det.gctMs != null && Math.abs(det.gctMs - m.contact_ms) <= 25,
      `${det.gctMs} vs ${m.contact_ms}`,
    ],
    [
      "flight ±25",
      det.flightMs != null && Math.abs(det.flightMs - m.flight_ms) <= 25,
      `${det.flightMs} vs ${m.flight_ms}`,
    ],
    [
      "height ±1.0",
      det.heightIn != null && Math.abs(det.heightIn - m.height_in) <= 1.0,
      `${det.heightIn} vs ${m.height_in}`,
    ],
  ];
  return { id, det, checks };
}

let failed = false;
for (const id of CLIPS) {
  console.log("\n===", id, "===");
  try {
    const r = await runClip(id);
    for (const [name, ok, detail] of r.checks) {
      console.log(ok ? "PASS" : "FAIL", name, detail);
      if (!ok) failed = true;
    }
    console.log(
      "summary",
      `TD ${r.det.td} TO ${r.det.to} LD ${r.det.ld} · contact ${r.det.gctMs} · flight ${r.det.flightMs} · height ${r.det.heightIn}`,
    );
  } catch (err) {
    failed = true;
    console.error("ERROR", id, err instanceof Error ? err.message : err);
  }
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
