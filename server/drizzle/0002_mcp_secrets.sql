ALTER TABLE `mcp_servers` ADD `env_enc` text;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `headers_enc` text;--> statement-breakpoint
ALTER TABLE `mcp_servers` DROP COLUMN `env`;--> statement-breakpoint
ALTER TABLE `mcp_servers` DROP COLUMN `headers`;