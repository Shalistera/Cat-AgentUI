CREATE TABLE `translate_ab_trials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`model_a` text NOT NULL,
	`model_b` text NOT NULL,
	`label_a` text NOT NULL,
	`label_b` text NOT NULL,
	`reasoning_a` text,
	`reasoning_b` text,
	`swapped` integer DEFAULT 0 NOT NULL,
	`mode` text NOT NULL,
	`source_lang` text NOT NULL,
	`target_lang` text NOT NULL,
	`source_chars` integer DEFAULT 0 NOT NULL,
	`tokens_a` integer DEFAULT 0 NOT NULL,
	`tokens_b` integer DEFAULT 0 NOT NULL,
	`duration_a` integer DEFAULT 0 NOT NULL,
	`duration_b` integer DEFAULT 0 NOT NULL,
	`vote` text,
	`scene` text,
	`source_text` text,
	`output_a` text,
	`output_b` text,
	`created_at` integer NOT NULL,
	`voted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_translate_ab_created` ON `translate_ab_trials` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_translate_ab_pair` ON `translate_ab_trials` (`model_a`,`model_b`);
