import { z } from "zod";

const userIdSchema = z.string().trim().min(1).max(128);

export const conversationIdParamsSchema = z.object({
  conversationId: userIdSchema,
});

export const participantParamsSchema = z.object({
  conversationId: userIdSchema,
  userId: userIdSchema,
});

export const userParamsSchema = z.object({ userId: userIdSchema });

export const messageParamsSchema = z.object({ messageId: userIdSchema });

export const listMessagesQuerySchema = z.object({
  cursor: userIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const listQuerySchema = z.object({
  cursor: userIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const userSearchQuerySchema = z.object({
  query: z.string().trim().min(2).max(64),
  cursor: userIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const privateConversationBodySchema = z.object({
  participantId: userIdSchema,
});

export const groupConversationBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  participantIds: z.array(userIdSchema).min(1).max(49),
});

export const addParticipantBodySchema = z.object({
  userId: userIdSchema,
});

export const messageBodySchema = z.object({
  content: z.string().trim().min(1).max(8000),
});

export const profileBodySchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  image: z.union([z.string().url().max(2048), z.null()]).optional(),
  statusMessage: z.string().trim().max(160).nullable().optional(),
}).refine(
  (profile) =>
    profile.name !== undefined ||
    profile.image !== undefined ||
    profile.statusMessage !== undefined,
);

export const groupNameBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
});
