ALTER TABLE `models` ADD `reasoning_mode` text DEFAULT 'auto' NOT NULL;
--> statement-breakpoint
-- A ladder the admin actually typed stays exactly as typed; everything else
-- (the '[]' that used to mean "no reasoning" only because nobody had configured
-- it) moves to the derived defaults.
UPDATE `models` SET `reasoning_mode` = 'custom' WHERE `reasoning_levels` NOT IN ('[]', '');
