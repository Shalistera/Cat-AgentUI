ALTER TABLE `providers` ADD `primary_name` text;--> statement-breakpoint
ALTER TABLE `providers` ADD `strip_model_prefix` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `providers` ADD `add_model_prefix` text DEFAULT '' NOT NULL;