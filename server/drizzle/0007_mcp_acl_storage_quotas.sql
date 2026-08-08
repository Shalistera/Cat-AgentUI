CREATE TABLE `mcp_server_access` (
	`server_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `user_id`),
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_access_user` ON `mcp_server_access` (`user_id`);--> statement-breakpoint
ALTER TABLE `images` ADD `byte_size` integer DEFAULT 0 NOT NULL;
