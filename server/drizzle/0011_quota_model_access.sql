CREATE TABLE `model_access` (
	`model_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`model_id`, `user_id`),
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_model_access_user` ON `model_access` (`user_id`);--> statement-breakpoint
ALTER TABLE `models` ADD `access_mode` text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `monthly_token_quota` integer;