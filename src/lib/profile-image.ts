import { createHash, createHmac } from "node:crypto";
import { env } from "../config/env.js";
import { HttpError } from "./errors.js";

export const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const profileFolder = "pingtalk/profiles";

export function validateProfileImage(buffer: Buffer, contentType: string) {
  if (!allowedImageTypes.has(contentType)) {
    throw new HttpError(415, "UNSUPPORTED_IMAGE_TYPE", "Choose a JPEG, PNG, or WebP image.");
  }
  if (buffer.byteLength === 0) {
    throw new HttpError(400, "EMPTY_IMAGE", "The selected image is empty.");
  }
  if (buffer.byteLength > PROFILE_IMAGE_MAX_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Profile images must be 5 MB or smaller.");
  }

  const isValidSignature =
    (contentType === "image/jpeg" &&
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff) ||
    (contentType === "image/png" &&
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )) ||
    (contentType === "image/webp" &&
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP");

  if (!isValidSignature) {
    throw new HttpError(400, "INVALID_IMAGE", "The selected file is not a valid image.");
  }
}

export function getProfileImagePublicId(userId: string) {
  const ownerHash = createHash("sha256").update(userId).digest("hex");
  return `${profileFolder}/${ownerHash}`;
}

function getCloudinaryConfig() {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new HttpError(
      503,
      "PROFILE_UPLOAD_UNAVAILABLE",
      "Profile photo storage is not configured.",
    );
  }
  return {
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKey: CLOUDINARY_API_KEY,
    apiSecret: CLOUDINARY_API_SECRET,
  };
}

function signCloudinaryParameters(
  parameters: Record<string, string>,
  apiSecret: string,
) {
  const canonical = Object.entries(parameters)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return createHmac("sha1", apiSecret).update(canonical).digest("hex");
}

export async function uploadProfileImage(
  userId: string,
  buffer: Buffer,
  contentType: string,
) {
  const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
  const publicId = getProfileImagePublicId(userId);
  const parameters = {
    folder: profileFolder,
    invalidate: "true",
    overwrite: "true",
    public_id: publicId.slice(profileFolder.length + 1),
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const signature = signCloudinaryParameters(parameters, apiSecret);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), "profile-image");
  form.append("api_key", apiKey);
  for (const [key, value] of Object.entries(parameters)) form.append(key, value);
  form.append("signature", signature);

  let response: Response;
  try {
    response = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`,
      { method: "POST", body: form, signal: AbortSignal.timeout(20_000) },
    );
  } catch {
    throw new HttpError(502, "IMAGE_STORAGE_FAILED", "Profile photo storage could not be reached.");
  }
  if (!response.ok) {
    throw new HttpError(502, "IMAGE_STORAGE_FAILED", "Profile photo storage rejected the upload.");
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new HttpError(502, "IMAGE_STORAGE_FAILED", "Profile photo storage returned an invalid response.");
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("secure_url" in result) ||
    typeof result.secure_url !== "string" ||
    !result.secure_url.startsWith("https://")
  ) {
    throw new HttpError(502, "IMAGE_STORAGE_FAILED", "Profile photo storage returned an invalid response.");
  }
  return { image: result.secure_url, publicId };
}

export async function deleteProfileImage(userId: string) {
  const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
  const publicId = getProfileImagePublicId(userId);
  const parameters = {
    invalidate: "true",
    public_id: publicId,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const form = new FormData();
  form.append("api_key", apiKey);
  for (const [key, value] of Object.entries(parameters)) form.append(key, value);
  form.append("signature", signCloudinaryParameters(parameters, apiSecret));

  let response: Response;
  try {
    response = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/destroy`,
      { method: "POST", body: form, signal: AbortSignal.timeout(20_000) },
    );
  } catch {
    throw new HttpError(502, "IMAGE_STORAGE_FAILED", "Profile photo storage could not be reached.");
  }
  if (!response.ok) {
    throw new HttpError(502, "IMAGE_STORAGE_FAILED", "Profile photo storage rejected the removal.");
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new HttpError(502, "IMAGE_STORAGE_FAILED", "Profile photo storage returned an invalid response.");
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("result" in result) ||
    (result.result !== "ok" && result.result !== "not found")
  ) {
    throw new HttpError(502, "IMAGE_STORAGE_FAILED", "Profile photo storage returned an invalid response.");
  }
  return publicId;
}

export function isProfileImageStorageConfigured() {
  return Boolean(
    env.CLOUDINARY_CLOUD_NAME &&
      env.CLOUDINARY_API_KEY &&
      env.CLOUDINARY_API_SECRET,
  );
}
