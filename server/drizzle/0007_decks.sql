CREATE TABLE `decks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text,
	`model` text,
	`topic` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`spec` text NOT NULL,
	`slide_count` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_decks_user` ON `decks` (`user_id`,`created_at`);