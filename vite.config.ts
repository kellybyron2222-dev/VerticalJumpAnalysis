import { defineConfig } from "vitest/config";

// Project Pages need base "/<repo>/". User sites and local dev stay on "/".
const base = process.env.VITE_BASE ?? "/";

export default defineConfig({
  base,
  server: {
    host: "0.0.0.0",
    port: 4731,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 4731,
    strictPort: true,
  },
  test: {
    environment: "node",
  },
});
