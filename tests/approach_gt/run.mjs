/**
 * Approach GT harness: Auto-detect each fixtures/approach/clip*_small.mp4
 * and compare plant TD/TO/LD (±3 fr), plant contact / flight (±25 ms),
 * height (±1.0 in), step gap (±30 ms) to fixtures/approach/ground_truth.json.
 *
 * Usage: node tests/approach_gt/run.mjs
 * Env: APPROACH_HEAVY=0 for lite (faster), default heavy.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = join(process.cwd(), "dist");
const FIX = join(process.cwd(), "fixtures/approach");
const GT = JSON.parse(readFileSync(join(FIX, "ground_truth.json"), "utf8"));
const HEAVY = process.env.APPROACH_HEAVY !== "0";
const CLIPS = (process.env.APPROACH_CLIPS ?? "clip0,clip2,clip3,clip4,clip5")
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

function heightInFromFlightMs(flightMs) {
  // h = 1/8 g t^2 ; g=9.80665; inches
  const t = flightMs / 1000;
  const meters = 0.5 * 9.80665 * (t / 2) ** 2;
  return meters / 0.0254;
}

function parseNum(text) {
  const m = String(text ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function parseFrame(text) {
  if (/started before clip|not set|—/i.test(String(text ?? ""))) return null;
  const m = String(text ?? "").match(/\d+/);
  return m ? Number(m[0]) : null;
}

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
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m?.[1] ?? 0);
      const end = m?.[2] ? Number(m[2]) : data.length - 1;
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${data.length}`,
        "Accept-Ranges": "bytes",
      });
      res.end(data.subarray(start, end + 1));
      return;
    }
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
console.log("GT harness server", port, "heavy", HEAVY);
console.log("clips in fixtures:", readdirSync(FIX).filter((f) => f.endsWith(".mp4")).join(", "));

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});
const page = await browser.newPage();
page.setDefaultTimeout(180_000);
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("CONSOLE", msg.text());
});

async function runClip(id) {
  const file = `${id}_small.mp4`;
  const path = join(FIX, file);
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const truth = GT[id];
  if (!truth?.frames) throw new Error(`no GT for ${id}`);

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    const guide = document.querySelector("#guide");
    const analyze = document.querySelector("#analyze");
    for (const el of document.querySelectorAll(".screen, #guide, #screen-box, #screen-master, #screen-profiles")) {
      el.hidden = true;
    }
    if (guide) guide.hidden = true;
    if (analyze) analyze.hidden = false;
  });
  await page.evaluate((heavy) => {
    const radio = document.querySelector('#jump-type-group input[value="penultimate"]');
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
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
      /Auto marks set|Check marks flagged|failed|cancelled|No plausible|Mark touchdown|started before clip/i.test(
        status,
      ) &&
      !/Scanning|Refining|Loading|Foot path|pose model/i.test(status)
    ) {
      break;
    }
    if (Date.now() - started > 480_000) throw new Error(`${id} detect timeout: ${status}`);
    await page.waitForTimeout(2000);
  }
  const detectMs = Date.now() - started;

  const det = await page.evaluate(() => {
    const num = (sel) => {
      const t = document.querySelector(sel)?.textContent ?? "";
      const m = t.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
      return m ? Number(m[0]) : null;
    };
    const frame = (sel) => {
      const t = document.querySelector(sel)?.textContent ?? "";
      if (/started before clip|not set/i.test(t)) return null;
      const m = t.match(/\d+/);
      return m ? Number(m[0]) : null;
    };
    return {
      detect: document.querySelector("#detect-status")?.textContent ?? "",
      td: frame("#td-frame"),
      to: frame("#to-frame"),
      ld: frame("#ld-frame"),
      penTd: frame("#pen-td-frame"),
      penTdLabel: document.querySelector("#pen-td-frame")?.textContent ?? "",
      penTo: frame("#pen-to-frame"),
      plantMs: num("#m-gct"),
      flightMs: num("#m-ft"),
      heightIn: num("#m-height"),
      gapMs: num("#m-step-gap"),
      penMsLabel: document.querySelector("#m-pen-gct")?.textContent ?? "",
      fps: Number(document.querySelector("#fps")?.value ?? 0),
      stretch: Number(document.querySelector("#slowmo")?.value ?? 0),
    };
  });

  const t = truth.frames;
  const m = truth.metrics;
  const checks = [];
  const row = {
    id,
    detect_ms: detectMs,
    det_td: det.td,
    gt_td: t.plant_td,
    det_to: det.to,
    gt_to: t.plant_to,
    det_ld: det.ld,
    gt_ld: t.landing,
    det_plant_ms: det.plantMs,
    gt_plant_ms: m.plant_contact_ms,
    det_flight_ms: det.flightMs,
    gt_flight_ms: m.flight_ms,
    det_height: det.heightIn,
    gt_height: m.height_in,
    det_gap_ms: det.gapMs,
    gt_gap_ms: m.step_gap_ms,
    pen_td_label: det.penTdLabel,
    pen_to: det.penTo,
    gt_pen_to: t.pen_to,
  };

  function check(name, ok, detail, required = true) {
    checks.push({ name, ok, detail, required });
  }
  // Ship gate: plant TO / landing / flight / height. Plant TD is suggestion-only.
  check("plant TO ±3", det.to != null && Math.abs(det.to - t.plant_to) <= 3, `${det.to} vs ${t.plant_to}`, true);
  check("landing ±3", det.ld != null && Math.abs(det.ld - t.landing) <= 3, `${det.ld} vs ${t.landing}`, true);
  check(
    "flight ms ±25",
    det.flightMs != null && Math.abs(det.flightMs - m.flight_ms) <= 25,
    `${det.flightMs} vs ${m.flight_ms}`,
    true,
  );
  check(
    "height ±1.0",
    det.heightIn != null && Math.abs(det.heightIn - m.height_in) <= 1.0,
    `${det.heightIn} vs ${m.height_in}`,
    true,
  );
  // Report-only (do not fail the ship gate).
  check("plant TD ±3", det.td != null && Math.abs(det.td - t.plant_td) <= 3, `${det.td} vs ${t.plant_td}`, false);
  check(
    "plant ms ±25",
    det.plantMs != null && Math.abs(det.plantMs - m.plant_contact_ms) <= 25,
    `${det.plantMs} vs ${m.plant_contact_ms}`,
    false,
  );
  check(
    "step gap ±30",
    det.gapMs != null && Math.abs(det.gapMs - m.step_gap_ms) <= 30,
    `${det.gapMs} vs ${m.step_gap_ms}`,
    false,
  );
  check("pen TD before clip", /started before clip/i.test(det.penTdLabel), det.penTdLabel, false);
  check(
    "pen contact blank",
    /started before clip|^—$|^-$|not set/i.test(String(det.penMsLabel ?? "")),
    det.penMsLabel,
    false,
  );

  return { row, checks, det, heightFromFlight: heightInFromFlightMs(m.flight_ms) };
}

const results = [];
let failed = false;
for (const id of CLIPS) {
  console.log("\n===", id, "===");
  try {
    const r = await runClip(id);
    results.push(r);
    for (const c of r.checks) {
      const tag = c.required === false ? "info" : c.ok ? "PASS" : "FAIL";
      console.log(tag, c.name, c.detail);
      if (c.required !== false && !c.ok) failed = true;
    }
  } catch (err) {
    failed = true;
    console.error("ERROR", id, err instanceof Error ? err.message : err);
    results.push({
      row: { id, error: String(err) },
      checks: [{ name: "run", ok: false, detail: String(err), required: true }],
    });
  }
}

console.log("\n=== SUMMARY (detected vs truth) ===");
console.log(
  "clip | sec | TD det/gt | TO det/gt | LD det/gt | plantMs det/gt | flightMs det/gt | height det/gt | gapMs det/gt",
);
for (const r of results) {
  const x = r.row;
  if (x.error) {
    console.log(x.id, "ERROR", x.error);
    continue;
  }
  const sec = x.detect_ms != null ? (x.detect_ms / 1000).toFixed(1) : "?";
  console.log(
    `${x.id} | ${sec}s | ${x.det_td}/${x.gt_td} | ${x.det_to}/${x.gt_to} | ${x.det_ld}/${x.gt_ld} | ${x.det_plant_ms?.toFixed?.(1) ?? x.det_plant_ms}/${x.gt_plant_ms} | ${x.det_flight_ms?.toFixed?.(1) ?? x.det_flight_ms}/${x.gt_flight_ms} | ${x.det_height?.toFixed?.(2) ?? x.det_height}/${x.gt_height} | ${x.det_gap_ms?.toFixed?.(1) ?? x.det_gap_ms}/${x.gt_gap_ms}`,
  );
}
console.log(
  "model",
  HEAVY ? "heavy" : "lite",
  "gate_failed",
  failed,
  "total_detect_s",
  (
    results.reduce((s, r) => s + (r.row.detect_ms ?? 0), 0) / 1000
  ).toFixed(1),
);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
