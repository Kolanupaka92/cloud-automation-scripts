/**
 * Service entry point.
 *
 * TLS terminates at the load balancer, which is configured for TLS 1.3 only;
 * this process listens on plain HTTP inside the mesh, where mTLS is applied by
 * the sidecar. It must never be exposed directly.
 */
import { createServer } from "node:http";
import { buildDeps, buildRouter, createRequestListener, shutdownDeps } from "./app.js";

const port = Number(process.env.PORT ?? 8080);

if (process.env.NODE_ENV === "production") {
  for (const required of [
    "DESI_NEXUS_TOKEN_SECRET",
    "DESI_NEXUS_WEBHOOK_SECRET",
    // Without this the service would silently fall back to the fake gateway
    // and accept bookings that move no money at all.
    "STRIPE_API_KEY",
    // And without this the rate limits are per-pod, which is to say not limits.
    "REDIS_URL",
    // And without this every booking is lost on the next restart.
    "DATABASE_URL",
  ]) {
    if (!process.env[required]) {
      console.error(`refusing to start: ${required} is not set`);
      process.exit(1);
    }
  }
}

const deps = buildDeps();
const server = createServer(createRequestListener(buildRouter(deps)));

server.listen(port, () => {
  console.log(`desi-nexus api listening on :${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // Stop accepting connections, then release what this process opened.
    server.close(() => {
      shutdownDeps().finally(() => process.exit(0));
    });
  });
}
