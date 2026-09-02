CREATE TABLE `bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_bookmarks_user_message` ON `bookmarks` (`user_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `idx_bookmarks_user` ON `bookmarks` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `confirm_calls` integer DEFAULT 0 NOT NULL;