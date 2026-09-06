ALTER TABLE `models` ADD `limit_period` text DEFAULT 'day' NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `limit_requests` integer;--> statement-breakpoint
ALTER TABLE `models` ADD `limit_tokens` integer;