ALTER TABLE `chats` ADD `current_leaf_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `parent_id` text;--> statement-breakpoint
UPDATE messages SET parent_id = (
  SELECT m2.id FROM messages m2
  WHERE m2.chat_id = messages.chat_id
    AND (m2.seq < messages.seq
      OR (m2.seq = messages.seq AND (m2.created_at < messages.created_at
        OR (m2.created_at = messages.created_at AND m2.rowid < messages.rowid))))
  ORDER BY m2.seq DESC, m2.created_at DESC, m2.rowid DESC LIMIT 1
);
