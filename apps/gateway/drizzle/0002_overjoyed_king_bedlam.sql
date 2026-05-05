CREATE TABLE `tenant_config` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`monthly_budget_usd` real,
	`daily_budget_usd` real,
	`rate_limit_rpm` integer,
	`rate_limit_tpm` integer,
	`allowed_providers` text,
	`allowed_models` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
