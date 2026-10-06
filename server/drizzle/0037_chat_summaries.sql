CREATE TABLE `chat_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`up_to_message_id` text NOT NULL,
	`summary` text NOT NULL,
	`covered` integer DEFAULT 0 NOT NULL,
	`model` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_summaries_chat` ON `chat_summaries` (`chat_id`,`created_at`);
