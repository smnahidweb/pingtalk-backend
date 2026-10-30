import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "./errors.js";
import {
  getProfileImagePublicId,
  PROFILE_IMAGE_MAX_BYTES,
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
