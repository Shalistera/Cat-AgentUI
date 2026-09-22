CREATE TABLE `provider_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text,
	`api_key_enc` text,
	`extra_headers_enc` text,
	`use_responses` integer,
	`strip_model_prefix` text DEFAULT '' NOT NULL,
	`add_model_prefix` text DEFAULT '' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_provider_endpoints_provider` ON `provider_endpoints` (`provider_id`,`priority`);--> statement-breakpoint
ALTER TABLE `providers` ADD `failover_threshold` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `providers` ADD `failover_cooldown_seconds` integer DEFAULT 60 NOT NULL;