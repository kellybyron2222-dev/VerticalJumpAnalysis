/** Bump on every deploy that must reach phones without a manual cache clear. */
export const BUILD_ID = "2026-10-27f";

const STORAGE_KEY = "jumpLab.buildUrl";

/**
 * Fetch build.json with a cache-busting query. If the hosted build differs from
 * this bundle, navigate to `?b=<build>` so Safari/CDN treat index.html as a new URL.
 */
export async function ensureLatestBuild(): Promise<void> {
  try {
    const url = new URL("build.json", document.baseURI);
    url.searchParams.set("t", String(Date.now()));
    const response = await fetch(url.href, { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as { build?: string };
    const remote = data.build;
    if (!remote || typeof remote !== "string") return;

    const params = new URLSearchParams(location.search);
    const urlBuild = params.get("b");
    if (urlBuild === remote && remote === BUILD_ID) return;

    if (remote !== BUILD_ID || urlBuild !== remote) {
      // Avoid a tight reload loop if something is stuck.
      const guardKey = `${STORAGE_KEY}:${remote}`;
      const last = sessionStorage.getItem(guardKey);
      if (last && Date.now() - Number(last) < 15_000) return;
      sessionStorage.setItem(guardKey, String(Date.now()));
      params.set("b", remote);
      const next = `${location.pathname}?${params.toString()}${location.hash}`;
      location.replace(next);
    }
  } catch {
    // Offline or blocked — keep the current page.
  }
}
