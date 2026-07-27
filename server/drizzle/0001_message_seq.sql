DROP INDEX `idx_messages_chat`;--> statement-breakpoint
ALTER TABLE `messages` ADD `seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `messages` SET `seq` = (
  SELECT COUNT(*) FROM `messages` AS m2
  WHERE m2.`chat_id` = `messages`.`chat_id`
    AND (m2.`created_at` < `messages`.`created_at`
      OR (m2.`created_at` = `messages`.`created_at` AND m2.`rowid` <= `messages`.`rowid`))
);--> statement-breakpoint
CREATE INDEX `idx_messages_chat` ON `messages` (`chat_id`,`seq`);