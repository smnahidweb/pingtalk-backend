import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { getAuthCookieAttributes } from "./lib/auth.js";
import { getSafeAuthExceptionDetails } from "./lib/errors.js";

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

test("auth cookies are secure in production and lax in all environments", () => {
  assert.deepEqual(getAuthCookieAttributes(true), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
  });
  assert.deepEqual(getAuthCookieAttributes(false), {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
  });
});

test("authentication diagnostics omit messages, causes, and metadata", () => {
  const error = Object.assign(
    new Error("email=person@example.invalid password=diagnostic-secret"),
    {
      name: "PrismaClientKnownRequestError",
      code: "P1001",
      meta: { email: "person@example.invalid" },
      cause: new Error("token=diagnostic-token"),
    },
  );
  const details = getSafeAuthExceptionDetails(error);
  const serialized = JSON.stringify(details);

  assert.equal(details.exceptionClass, "PrismaClientKnownRequestError");
  assert.equal(details.databaseCode, "P1001");
  assert.ok(details.stackFrames?.length);
  assert.equal("message" in details, false);
  assert.equal("cause" in details, false);
  assert.equal("meta" in details, false);
  assert.doesNotMatch(serialized, /person@example\.invalid|diagnostic-secret|diagnostic-token/);
});

test("authentication diagnostics reject unsafe error codes", () => {
  for (const code of ["user@example.invalid", "TOKEN"]) {
    const error = Object.assign(new Error("do not log"), { code });
    assert.equal(getSafeAuthExceptionDetails(error).databaseCode, undefined);
  }
});

test("authentication diagnostics normalize unknown exception names", () => {
  const error = Object.assign(new Error("do not log"), {
    name: "diagnostic-secret",
  });
  assert.equal(getSafeAuthExceptionDetails(error).exceptionClass, "Error");
});

test("unexpected sign-in exceptions return only the generic error response", async () => {
  const authApp = createApp({
    authHandler: (_request, _response, next) => {
      next(new Error("diagnostic-only exception message"));
    },
  });
  const response = await request(authApp).post("/api/auth/sign-in/email");

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, {
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
  });
  assert.equal(JSON.stringify(response.body).includes("diagnostic-only"), false);
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

test("CORS permits the attachment upload headers from the configured frontend", async () => {
  const response = await request(app)
    .options("/api/conversations/conversation-id/attachments")
    .set("Origin", env.CORS_ORIGIN)
    .set("Access-Control-Request-Method", "POST")
    .set("Access-Control-Request-Headers", "content-type,x-file-name,x-upload-id");
  assert.equal(response.status, 204);
  assert.match(
    response.headers["access-control-allow-headers"] ?? "",
    /X-File-Name/i,
  );
  assert.match(
    response.headers["access-control-allow-headers"] ?? "",
    /X-Upload-Id/i,
  );
});

test("Railway ingress trusts one proxy hop for rate-limited routes", async () => {
  const originalRailwayEnvironment = process.env.RAILWAY_ENVIRONMENT;
  process.env.RAILWAY_ENVIRONMENT = "production";

  try {
    const railwayApp = createApp({ mountAuth: false });
    assert.equal(railwayApp.get("trust proxy"), 1);
    const response = await request(railwayApp)
      .get("/api/users?query=ping")
      .set("X-Forwarded-For", "203.0.113.10");
    assert.equal(response.status, 401);
  } finally {
    if (originalRailwayEnvironment === undefined) {
      delete process.env.RAILWAY_ENVIRONMENT;
    } else {
      process.env.RAILWAY_ENVIRONMENT = originalRailwayEnvironment;
    }
  }
});

test("Render ingress trusts one proxy hop for rate-limited routes", async () => {
  const originalRender = process.env.RENDER;
  const originalRailwayEnvironment = process.env.RAILWAY_ENVIRONMENT;
  process.env.RENDER = "true";
  delete process.env.RAILWAY_ENVIRONMENT;

  try {
    const renderApp = createApp({ mountAuth: false });
    assert.equal(renderApp.get("trust proxy"), 1);
    const response = await request(renderApp)
      .get("/api/users?query=ping")
      .set("X-Forwarded-For", "203.0.113.11");
    assert.equal(response.status, 401);
  } finally {
    if (originalRender === undefined) {
      delete process.env.RENDER;
    } else {
      process.env.RENDER = originalRender;
    }
    if (originalRailwayEnvironment === undefined) {
      delete process.env.RAILWAY_ENVIRONMENT;
    } else {
      process.env.RAILWAY_ENVIRONMENT = originalRailwayEnvironment;
    }
  }
});

test("an explicitly false Render marker does not enable proxy trust", () => {
  const originalRender = process.env.RENDER;
  const originalRailwayEnvironment = process.env.RAILWAY_ENVIRONMENT;
  process.env.RENDER = "false";
  delete process.env.RAILWAY_ENVIRONMENT;

  try {
    const localApp = createApp({ mountAuth: false });
    assert.equal(localApp.get("trust proxy"), false);
  } finally {
    if (originalRender === undefined) {
      delete process.env.RENDER;
    } else {
      process.env.RENDER = originalRender;
    }
    if (originalRailwayEnvironment === undefined) {
      delete process.env.RAILWAY_ENVIRONMENT;
    } else {
      process.env.RAILWAY_ENVIRONMENT = originalRailwayEnvironment;
    }
  }
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

  test("profile photo mutations and message reactions require authentication", async () => {
    const [upload, remove, reaction, attachment, attachmentContent] = await Promise.all([
      request(app)
        .post("/api/me/image")
        .set("Content-Type", "image/png")
        .send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      request(app).delete("/api/me/image"),
      request(app)
        .post("/api/messages/message-id/reactions")
        .send({ emoji: "👍" }),
      request(app)
        .post("/api/conversations/conversation-id/attachments")
        .set("Content-Type", "application/pdf")
        .set("X-File-Name", "report.pdf")
        .set("X-Upload-Id", "b67d30b4-9f4f-4e8d-a5a2-f70ea35fe61f")
        .send(Buffer.from("%PDF-1.7\n", "ascii")),
      request(app).get("/api/attachments/attachment-id/content"),
    ]);
    assert.equal(upload.status, 401);
    assert.equal(remove.status, 401);
    assert.equal(reaction.status, 401);
    assert.equal(attachment.status, 401);
    assert.equal(attachmentContent.status, 401);
  });
});
