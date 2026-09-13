/**
 * Service entry point.
 *
 * TLS terminates at the load balancer, which is configured for TLS 1.3 only;
 * this process listens on plain HTTP inside the mesh, where mTLS is applied by
 * the sidecar. It must never be exposed directly.
 */
import { createServer } from "node:http";
import { buildDeps, buildRouter, createRequestListener } from "./app.js";

const port = Number(process.env.PORT ?? 8080);

if (process.env.NODE_ENV === "production") {
  for (const required of [
    "DESI_NEXUS_TOKEN_SECRET",
    "DESI_NEXUS_WEBHOOK_SECRET",
    // Without this the service would silently fall back to the fake gateway
    // and accept bookings that move no money at all.
    "STRIPE_API_KEY",
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
    server.close(() => process.exit(0));
  });
}
