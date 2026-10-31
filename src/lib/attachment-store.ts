export type StoredAttachment = {
  id: string;
  messageId: string;
  conversationId: string;
  uploadId: string;
  fileName: string;
  contentType: string;
  fileSize: number;
  url: string;
  publicId: string;
  resourceType: "raw" | "image";
  createdAt: Date;
};

export class AttachmentStore {
  private readonly byId = new Map<string, StoredAttachment>();
  private readonly byUploadId = new Map<string, StoredAttachment>();
  private readonly byMessageId = new Map<string, StoredAttachment[]>();
  private readonly latestByConversationId = new Map<string, StoredAttachment>();

  create(attachment: StoredAttachment): StoredAttachment {
    this.byId.set(attachment.id, attachment);
    this.byUploadId.set(attachment.uploadId, attachment);

    const list = this.byMessageId.get(attachment.messageId) ?? [];
    list.push(attachment);
    this.byMessageId.set(attachment.messageId, list);

    this.latestByConversationId.set(attachment.conversationId, attachment);
    return attachment;
  }

  findById(id: string): StoredAttachment | null {
    return this.byId.get(id) ?? null;
  }

  findByUploadId(uploadId: string): StoredAttachment | null {
    return this.byUploadId.get(uploadId) ?? null;
  }

  findByMessageId(messageId: string): StoredAttachment[] {
    return this.byMessageId.get(messageId) ?? [];
  }

  findLatestByConversationId(conversationId: string): StoredAttachment | null {
    return this.latestByConversationId.get(conversationId) ?? null;
  }
}

export const attachmentStore = new AttachmentStore();

