CREATE TABLE `customer_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`config_hash` text NOT NULL,
	`json_content` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_configs_config_hash_unique` ON `customer_configs` (`config_hash`);--> statement-breakpoint
CREATE TABLE `draft_configs` (
	`session_id` text PRIMARY KEY NOT NULL,
	`json_content` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `singbox_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`json_content` text NOT NULL,
	`version` text DEFAULT '1.8.0',
	`created_at` integer DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`last_hash` text,
	`user_info` text,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_config_hash` text,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`customer_config_hash`) REFERENCES `customer_configs`(`config_hash`) ON UPDATE no action ON DELETE no action
);
