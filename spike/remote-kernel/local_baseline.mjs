// SPIKE: per-cell latency of prime's KernelManager in-process, no WebSocket, for comparison.
import { join } from "node:path";
const CA = new URL("../../vendor/prime-agent/packages/coding-agent/", import.meta.url).pathname;
const { KernelManager } = await import(join(CA, "dist/core/kernel/index.js"));
const km = new KernelManager({ cwd: "/tmp/rk-local" });
let t = performance.now(); await km.start(); const startMs = performance.now() - t;
await km.execute("1+1");
const xs = [];
for (let i = 0; i < 25; i++) { t = performance.now(); await km.execute("1+1"); xs.push(performance.now() - t); }
xs.sort((a, b) => a - b);
console.log(JSON.stringify({ startMs: +startMs.toFixed(0), cellMs: { p50: +xs[12].toFixed(1), p90: +xs[21].toFixed(1), min: +xs[0].toFixed(1) } }));
await km.dispose(); process.exit(0);
