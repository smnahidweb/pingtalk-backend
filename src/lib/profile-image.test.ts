import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { HttpError } from "./errors.js";
import {
  getProfileImagePublicId,
  getAuthenticatedCloudinaryAssetUrl,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  PROFILE_IMAGE_MAX_BYTES,
  sanitizeAttachmentFileName,
  signCloudinaryParameters,
  validateMessageAttachment,
  validateProfileImage,
} from "./profile-image.js";

test("profile image validation accepts only matching JPEG, PNG, and WebP files", () => {
  validateProfileImage(Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg");
  validateProfileImage(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    "image/png",
  );
  validateProfileImage(
    Buffer.from("RIFF0000WEBP", "ascii"),
    "image/webp",
  );
  assert.throws(
    () => validateProfileImage(Buffer.from("<svg/>"), "image/svg+xml"),
    (error: unknown) =>
      error instanceof HttpError && error.status === 415,
  );
  assert.throws(
    () => validateProfileImage(Buffer.from("<script>"), "image/png"),
    (error: unknown) =>
      error instanceof HttpError && error.code === "INVALID_IMAGE",
  );
});

test("profile image validation rejects empty and oversized files", () => {
  assert.throws(
    () => validateProfileImage(Buffer.alloc(0), "image/png"),
    (error: unknown) =>
      error instanceof HttpError && error.code === "EMPTY_IMAGE",
  );
  assert.throws(
    () => validateProfileImage(Buffer.alloc(PROFILE_IMAGE_MAX_BYTES + 1), "image/png"),
    (error: unknown) =>
      error instanceof HttpError && error.status === 413,
  );
});

test("Cloudinary profile asset IDs are stable and do not expose account IDs", () => {
  const first = getProfileImagePublicId("user-secret-id");
  assert.equal(first, getProfileImagePublicId("user-secret-id"));
  assert.notEqual(first, getProfileImagePublicId("another-user"));
  assert.equal(first.includes("user-secret-id"), false);
  assert.match(first, /^pingtalk\/profiles\/[a-f0-9]{64}$/);
});

test("Cloudinary signatures use SHA-1 over sorted parameters and the API secret", () => {
  const parameters = {
    timestamp: "1700000000",
    public_id: "asset123",
    folder: "pingtalk",
    type: "authenticated",
    overwrite: "true",
  };
  const apiSecret = "test-secret";
  const canonical = Object.entries(parameters)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const signature = signCloudinaryParameters(parameters, apiSecret);

  assert.equal(
    signature,
    createHash("sha1").update(`${canonical}${apiSecret}`).digest("hex"),
  );
  assert.notEqual(
    signature,
    createHmac("sha1", apiSecret).update(canonical).digest("hex"),
  );
});

test("private attachment URLs must be authenticated assets from the configured Cloudinary account", () => {
  const valid =
    "https://res.cloudinary.com/pingtalk/image/authenticated/pingtalk/file.jpg";
  const signed = getAuthenticatedCloudinaryAssetUrl(
    valid,
    "pingtalk",
    "image",
    "test-secret",
  );
  assert.equal(
    signed,
    getAuthenticatedCloudinaryAssetUrl(
      "https://res.cloudinary.com/pingtalk/image/authenticated/s--AAAAAAAA--/pingtalk/file.jpg",
      "pingtalk",
      "image",
      "test-secret",
    ),
  );
  for (const invalid of [
    "https://example.invalid/pingtalk/image/authenticated/file",
    "https://res.cloudinary.com/other/image/authenticated/file",
    "https://res.cloudinary.com/pingtalk/image/upload/file",
    "https://res.cloudinary.com/pingtalk/raw/authenticated/file",
    "http://res.cloudinary.com/pingtalk/image/authenticated/file",
  ]) {
    assert.throws(
      () => getAuthenticatedCloudinaryAssetUrl(invalid, "pingtalk", "image", "test-secret"),
      (error: unknown) =>
        error instanceof HttpError && error.code === "FILE_STORAGE_FAILED",
    );
  }
});

test("authenticated Cloudinary delivery signature matches the documented SHA-1 vector", () => {
  assert.equal(
    getAuthenticatedCloudinaryAssetUrl(
      "https://res.cloudinary.com/demo/image/authenticated/c_fill,w_300,h_250/e_grayscale/sample-authenticated.png",
      "demo",
      "image",
      "abcd",
    ),
    "https://res.cloudinary.com/demo/image/authenticated/s--iDy_JeBq--/c_fill,w_300,h_250/e_grayscale/sample-authenticated.png",
  );
});

test("message attachment validation accepts supported image signatures and PDFs", () => {
  validateMessageAttachment(
    Buffer.from([0xff, 0xd8, 0xff, 0x00]),
    "image/jpeg",
  );
  validateMessageAttachment(
    Buffer.from("%PDF-1.7\n", "ascii"),
    "application/pdf",
  );
  assert.throws(
    () => validateMessageAttachment(Buffer.from("<svg/>"), "image/svg+xml"),
    (error: unknown) =>
      error instanceof HttpError && error.code === "UNSUPPORTED_FILE_TYPE",
  );
  assert.throws(
    () => validateMessageAttachment(Buffer.from("not pdf"), "application/pdf"),
    (error: unknown) =>
      error instanceof HttpError && error.code === "INVALID_FILE",
  );
  assert.throws(
    () =>
      validateMessageAttachment(
        Buffer.alloc(MESSAGE_ATTACHMENT_MAX_BYTES + 1),
        "application/pdf",
      ),
    (error: unknown) =>
      error instanceof HttpError && error.status === 413,
  );
});

test("attachment filenames are reduced to safe basenames", () => {
  assert.equal(sanitizeAttachmentFileName("../../report.pdf"), "report.pdf");
  assert.equal(sanitizeAttachmentFileName("folder\\image.png"), "image.png");
  assert.throws(
    () => sanitizeAttachmentFileName("../"),
    (error: unknown) =>
      error instanceof HttpError && error.code === "INVALID_FILE_NAME",
  );
});
