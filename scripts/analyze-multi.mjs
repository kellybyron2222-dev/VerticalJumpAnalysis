import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const root = join(process.cwd(), "dist");
const pts = JSON.parse(await readFile(join(process.cwd(), "src/fixtures/img0228-pts.json"), "utf8"));
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  path = decodeURIComponent(path);
  try {
    const file = join(root, path.replace(/^\//, ""));
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("missing");
  }
});

await new Promise((resolve) => server.listen(4789, "127.0.0.1", resolve));
console.log("server up", pts.length, "pts");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(600_000);
page.on("console", (msg) => console.log("console:", msg.text()));

await page.goto("http://127.0.0.1:4789/?b=2026-10-14o");
await page.getByRole("button", { name: "Jump Analysis" }).click().catch(() => {});
await page.evaluate(async () => {
  const res = await fetch("multi_small.mp4");
  const blob = await res.blob();
  const file = new File([blob], "IMG_0228_proxy.mp4", { type: "video/mp4" });
  const input = document.querySelector("#video-input");
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(2000);
await page.evaluate((times) => {
  window.__jumpLabApplyPts?.(times);
}, pts);
await page.waitForFunction(() => {
  const btn = document.querySelector("#auto-detect");
  return btn && !btn.disabled;
}, null, { timeout: 60_000 });
console.log("auto-detect enabled, starting…");
await page.click("#auto-detect");

let last = "";
for (let i = 0; i < 600; i += 1) {
  const status = await page.locator("#detect-status").innerText().catch(() => "");
  if (status !== last) {
    console.log("status:", status);
    last = status;
  }
  const panelHidden = await page.locator("#multi-jump-panel").isHidden();
  if (!panelHidden || /Auto marks set|Found \d+ jumps|failed/i.test(status)) break;
  await page.waitForTimeout(1000);
}

const report = await page.evaluate(() => {
  const status = document.querySelector("#detect-status")?.textContent ?? "";
  const summary = document.querySelector("#multi-jump-summary")?.textContent ?? "";
  const items = [...document.querySelectorAll("#multi-jump-list .multi-jump-item")].map((li) =>
    (li.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
  const marks = {
    td: document.querySelector("#td-frame")?.textContent,
    to: document.querySelector("#to-frame")?.textContent,
    ld: document.querySelector("#ld-frame")?.textContent,
  };
  const metrics = document.querySelector("#metrics-values")?.textContent ?? "";
  return { status, summary, items, marks, metrics };
});

console.log("REPORT", JSON.stringify(report, null, 2));
await browser.close();
server.close();
