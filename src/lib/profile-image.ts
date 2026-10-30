import { createHash, createHmac } from "node:crypto";
import { env } from "../config/env.js";
import { HttpError } from "./errors.js";
import { logger } from "./logger.js";

export const PROFILE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const MESSAGE_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const allowedAttachmentTypes = new Set([
  ...allowedImageTypes,
  "application/pdf",
]);
const profileFolder = "pingtalk/profiles";
const attachmentFolder = "pingtalk/conversations";

export function validateProfileImage(buffer: Buffer, contentType: string) {
  if (!allowedImageTypes.has(contentType)) {
    throw new HttpError(415, "UNSUPPORTED_IMAGE_TYPE", "Choose a JPEG, PNG, or WebP image.");
  }
  if (buffer.byteLength === 0) {
    throw new HttpError(400, "EMPTY_IMAGE", "The selected image is empty.");
  }
  if (buffer.byteLength > PROFILE_IMAGE_MAX_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Profile images must be 4 MB or smaller.");
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

export function sanitizeAttachmentFileName(fileName: string) {
  const name = fileName.replace(/\\/g, "/").split("/").at(-1)?.trim() ?? "";
  const safeName = name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255);
  if (!safeName || safeName === "." || safeName === "..") {
    throw new HttpError(400, "INVALID_FILE_NAME", "Choose a file with a valid name.");
  }
  return safeName;
}

export function validateMessageAttachment(
  buffer: Buffer,
  contentType: string,
) {
  if (!allowedAttachmentTypes.has(contentType)) {
    throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", "Share a JPEG, PNG, WebP, or PDF file.");
  }
  if (buffer.byteLength === 0) {
    throw new HttpError(400, "EMPTY_FILE", "The selected file is empty.");
  }
  if (buffer.byteLength > MESSAGE_ATTACHMENT_MAX_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Files must be 4 MB or smaller.");
  }
  if (contentType === "application/pdf") {
    if (buffer.length < 5 || buffer.toString("ascii", 0, 5) !== "%PDF-") {
      throw new HttpError(400, "INVALID_FILE", "The selected file is not a valid PDF.");
    }
    return;
  }
  validateProfileImage(buffer, contentType);
}

export function getProfileImagePublicId(userId: string) {
  const ownerHash = createHash("sha256").update(userId).digest("hex");
  return `${profileFolder}/${ownerHash}`;
}

function getCloudinaryConfig() {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    logger.warn(
      {
        cloudNameConfigured: Boolean(CLOUDINARY_CLOUD_NAME),
        apiKeyConfigured: Boolean(CLOUDINARY_API_KEY),
        apiSecretConfigured: Boolean(CLOUDINARY_API_SECRET),
      },
      "Cloudinary uploads are unavailable because required settings are missing",
    );
    throw new HttpError(
      503,
      "PROFILE_UPLOAD_UNAVAILABLE",
      "Cloudinary file storage is not configured.",
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

async function uploadCloudinaryBuffer({
  apiKey,
  apiSecret,
  cloudName,
  buffer,
  contentType,
  fileName,
  folder,
  publicId,
  resourceType,
  accessType,
  overwrite,
  invalidate,
}: {
  apiKey: string;
  apiSecret: string;
  cloudName: string;
  buffer: Buffer;
  contentType: string;
  fileName: string;
  folder: string;
  publicId: string;
  resourceType: "image" | "raw";
  accessType?: "authenticated";
  overwrite: boolean;
  invalidate?: boolean;
}) {
  const parameters = {
    folder,
    ...(invalidate ? { invalidate: "true" } : {}),
    overwrite: String(overwrite),
    public_id: publicId,
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...(accessType ? { type: accessType } : {}),
  };
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), fileName);
  form.append("api_key", apiKey);
  for (const [key, value] of Object.entries(parameters)) form.append(key, value);
  form.append("signature", signCloudinaryParameters(parameters, apiSecret));

  let response: Response;
  try {
    response = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${resourceType}/upload`,
      { method: "POST", body: form, signal: AbortSignal.timeout(30_000) },
    );
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError", resourceType },
      "Cloudinary upload request failed",
    );
    throw new HttpError(502, "IMAGE_STORAGE_FAILED", "File storage could not be reached.");
  }
  if (!response.ok) {
    logger.warn(
      { statusCode: response.status, resourceType },
      "Cloudinary rejected an upload request",
    );
    throw new HttpError(502, "IMAGE_STORAGE_FAILED", "File storage rejected the upload.");
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    logger.warn({ resourceType }, "Cloudinary returned an invalid upload response");
    throw new HttpError(502, "IMAGE_STORAGE_FAILED", "File storage returned an invalid response.");
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("secure_url" in result) ||
    typeof result.secure_url !== "string" ||
    !result.secure_url.startsWith("https://") ||
    !("public_id" in result) ||
    typeof result.public_id !== "string"
  ) {
    logger.warn({ resourceType }, "Cloudinary returned incomplete upload metadata");
    throw new HttpError(502, "IMAGE_STORAGE_FAILED", "File storage returned an invalid response.");
  }
  return { url: result.secure_url, publicId: result.public_id };
}

export async function uploadProfileImage(
  userId: string,
  buffer: Buffer,
  contentType: string,
) {
  const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
  const publicId = getProfileImagePublicId(userId);
  const uploaded = await uploadCloudinaryBuffer({
    apiKey,
    apiSecret,
    cloudName,
    buffer,
    contentType,
    fileName: "profile-image",
    folder: profileFolder,
    publicId: publicId.slice(profileFolder.length + 1),
    resourceType: "image",
    overwrite: true,
    invalidate: true,
  });
  return { image: uploaded.url };
}

export async function uploadMessageAttachment(
  conversationId: string,
  userId: string,
  buffer: Buffer,
  contentType: string,
  fileName: string,
  uploadId: string,
) {
  const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
  const resourceType: "raw" | "image" =
    contentType === "application/pdf" ? "raw" : "image";
  const extension = resourceType === "raw" ? ".pdf" : "";
  const folder = `${attachmentFolder}/${createHash("sha256")
    .update(conversationId)
    .digest("hex")}`;
  const publicId = `${createHash("sha256")
    .update(`${userId}:${uploadId}`)
    .digest("hex")}${extension}`;
  const uploaded = await uploadCloudinaryBuffer({
    apiKey,
    apiSecret,
    cloudName,
    buffer,
    contentType,
    fileName,
    folder,
    publicId,
    resourceType,
    accessType: "authenticated",
    overwrite: true,
  });
  return {
    uploadId,
    fileName,
    contentType,
    fileSize: buffer.byteLength,
    url: uploaded.url,
    publicId: uploaded.publicId,
    resourceType,
  };
}

export function getAuthenticatedCloudinaryAssetUrl(
  assetUrl: string,
  cloudName: string,
  resourceType: "image" | "raw",
) {
  let url: URL;
  try {
    url = new URL(assetUrl);
  } catch {
    throw new HttpError(502, "FILE_STORAGE_FAILED", "Stored file metadata is invalid.");
  }
  const expectedPathPrefix =
    `/${encodeURIComponent(cloudName)}/${resourceType}/authenticated/`;
  if (
    url.origin !== "https://res.cloudinary.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(expectedPathPrefix)
  ) {
    throw new HttpError(502, "FILE_STORAGE_FAILED", "Stored file metadata is invalid.");
  }
  return url.toString();
}

export async function fetchPrivateMessageAttachment(
  assetUrl: string,
  resourceType: "image" | "raw",
  expectedSize: number,
) {
  const { cloudName } = getCloudinaryConfig();
  const safeUrl = getAuthenticatedCloudinaryAssetUrl(
    assetUrl,
    cloudName,
    resourceType,
  );
  let response: Response;
  try {
    response = await fetch(safeUrl, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError", resourceType },
      "Cloudinary attachment delivery request failed",
    );
    throw new HttpError(502, "FILE_DELIVERY_FAILED", "The shared file could not be retrieved.");
  }
  if (!response.ok) {
    logger.warn(
      { statusCode: response.status, resourceType },
      "Cloudinary rejected an attachment delivery request",
    );
    throw new HttpError(502, "FILE_DELIVERY_FAILED", "The shared file could not be retrieved.");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new HttpError(502, "FILE_DELIVERY_FAILED", "The shared file could not be retrieved.");
  }
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > MESSAGE_ATTACHMENT_MAX_BYTES) {
        await reader.cancel();
        logger.warn({ resourceType }, "Cloudinary returned an oversized attachment");
        throw new HttpError(502, "FILE_DELIVERY_FAILED", "The shared file could not be retrieved.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError", resourceType },
      "Cloudinary attachment response could not be read",
    );
    throw new HttpError(502, "FILE_DELIVERY_FAILED", "The shared file could not be retrieved.");
  }
  if (totalSize !== expectedSize) {
    logger.warn({ resourceType }, "Cloudinary attachment size did not match stored metadata");
    throw new HttpError(502, "FILE_DELIVERY_FAILED", "The shared file could not be retrieved.");
  }
  return Buffer.concat(chunks, totalSize);
}

export async function deleteProfileImage(userId: string) {
  const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
  const publicId = getProfileImagePublicId(userId);
  await deleteCloudinaryAsset(publicId, "image", { cloudName, apiKey, apiSecret });
  return publicId;
}

export async function deleteCloudinaryAsset(
  publicId: string,
  resourceType: "image" | "raw",
  config = getCloudinaryConfig(),
  accessType?: "authenticated",
) {
  const { cloudName, apiKey, apiSecret } = config;
  const parameters = {
    invalidate: "true",
    public_id: publicId,
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...(accessType ? { type: accessType } : {}),
  };
  const form = new FormData();
  form.append("api_key", apiKey);
  for (const [key, value] of Object.entries(parameters)) form.append(key, value);
  form.append("signature", signCloudinaryParameters(parameters, apiSecret));

  let response: Response;
  try {
    response = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${resourceType}/destroy`,
      { method: "POST", body: form, signal: AbortSignal.timeout(20_000) },
    );
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError", resourceType },
      "Cloudinary asset removal request failed",
    );
    throw new HttpError(502, "IMAGE_STORAGE_FAILED", "Profile photo storage could not be reached.");
  }
  if (!response.ok) {
    logger.warn(
      { statusCode: response.status, resourceType },
      "Cloudinary rejected an asset removal request",
    );
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
