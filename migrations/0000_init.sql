CREATE TABLE `account_tab` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user_tab`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user` ON `account_tab` (`user_id`);--> statement-breakpoint
CREATE TABLE `audit_log_tab` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`type` text,
	`target` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_at` ON `audit_log_tab` (`at`);--> statement-breakpoint
CREATE TABLE `invite_tab` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`created_by` text,
	`types` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_by` text,
	`used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `ip_block_tab` (
	`ip_key` text PRIMARY KEY NOT NULL,
	`reason` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `moderator_permission_tab` (
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`granted_by` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `type`),
	FOREIGN KEY (`user_id`) REFERENCES `user_tab`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`type`) REFERENCES `submission_type_tab`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session_tab` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user_tab`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_tab_token_unique` ON `session_tab` (`token`);--> statement-breakpoint
CREATE INDEX `session_user` ON `session_tab` (`user_id`);--> statement-breakpoint
CREATE TABLE `submission_tab` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`group_id` text NOT NULL,
	`state` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`payload` text NOT NULL,
	`tags` text NOT NULL,
	`lang` text NOT NULL,
	`explanation` text NOT NULL,
	`explanation_html` text NOT NULL,
	`demo_url` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state_changed_at` integer NOT NULL,
	`moderated_by` text,
	`original` text,
	`ip` text,
	`ip_key` text NOT NULL,
	`country` text,
	`ai_verdict` text,
	`ai_reason` text,
	FOREIGN KEY (`type`) REFERENCES `submission_type_tab`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `submission_list` ON `submission_tab` (`type`,`group_id`,`state`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `submission_state` ON `submission_tab` (`state`,`state_changed_at`);--> statement-breakpoint
CREATE INDEX `submission_ip` ON `submission_tab` (`ip_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `submission_type_tab` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`allowed_origins` text NOT NULL,
	`plugin_url` text NOT NULL,
	`groups_url` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_tab` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_tab_email_unique` ON `user_tab` (`email`);--> statement-breakpoint
CREATE TABLE `verification_tab` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `verification_identifier` ON `verification_tab` (`identifier`);