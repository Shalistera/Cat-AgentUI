ALTER TABLE `images` ADD `source` text DEFAULT 'workshop' NOT NULL;--> statement-breakpoint
UPDATE `images` SET `source` = 'chat' WHERE EXISTS (
  SELECT 1 FROM `messages` m WHERE m.parts LIKE '%' || `images`.`id` || '%'
);
