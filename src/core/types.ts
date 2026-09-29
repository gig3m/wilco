/** Only the wire fields Wilco actually reads. */
export interface JmapEmail {
  id: string;
  threadId?: string;
  receivedAt?: string;
  subject?: string;
  preview?: string;
  hasAttachment?: boolean;
  keywords?: Record<string, boolean>;
  mailboxIds?: Record<string, boolean>;
  from?: { name?: string | null; email?: string }[];
}

export interface JmapMailbox {
  id: string;
  name: string;
  role?: string | null;
  parentId?: string | null;
  sortOrder?: number;
  totalEmails?: number;
  unreadEmails?: number;
}
