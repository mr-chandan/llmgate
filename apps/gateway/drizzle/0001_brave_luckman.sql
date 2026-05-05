CREATE TABLE `request_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`api_key_id` text,
	`provider_id` text,
	`requested_model` text NOT NULL,
	`resolved_model` text,
	`status` integer NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`ttfb_ms` integer,
	`attempts` integer DEFAULT 1 NOT NULL,
	`streamed` integer DEFAULT false NOT NULL,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `request_logs_tenant_idx` ON `request_logs` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `request_logs_model_idx` ON `request_logs` (`resolved_model`);