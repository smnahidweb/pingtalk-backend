import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "./app.js";
import { env } from "./config/env.js";

const app = createApp({ mountAuth: false });

test("health endpoint reports service status without database details", async () => {
  const response = await request(app).get("/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(
    { status: response.body.status, service: response.body.service },
    { status: "ok", service: "pingtalk-api" },
  );
  assert.equal("databaseUrl" in response.body, false);
});

test("CORS accepts the configured frontend origin and credentials", async () => {
  const response = await request(app)
    .get("/api/health")
    .set("Origin", env.CORS_ORIGIN);
  assert.equal(response.headers["access-control-allow-origin"], env.CORS_ORIGIN);
  assert.equal(response.headers["access-control-allow-credentials"], "true");
});

test("CORS does not reflect an untrusted origin", async () => {
  const response = await request(app)
    .get("/api/health")
    .set("Origin", "https://untrusted.invalid");
  assert.equal(response.status, 403);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("unknown routes use the consistent API error envelope", async () => {
  const response = await request(app).get("/missing");
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    error: { code: "NOT_FOUND", message: "The requested endpoint was not found." },
  });
});

test("protected profile endpoint rejects unauthenticated requests", async () => {
  const response = await request(app).get("/api/me");
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
  });
});
