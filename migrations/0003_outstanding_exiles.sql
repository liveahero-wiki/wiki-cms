CREATE TABLE `contrib_token_tab` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user_tab`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contrib_token_user` ON `contrib_token_tab` (`user_id`);--> statement-breakpoint
CREATE INDEX `contrib_token_expires` ON `contrib_token_tab` (`expires_at`);--> statement-breakpoint
CREATE TABLE `contributor_tab` (
	`user_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`trust_level` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user_tab`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `submission_revision_tab` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`user_id` text,
	`state` text NOT NULL,
	`base_version` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`payload` text NOT NULL,
	`tags` text NOT NULL,
	`lang` text NOT NULL,
	`explanation` text NOT NULL,
	`explanation_html` text NOT NULL,
	`demo_url` text NOT NULL,
	`reject_reason` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	FOREIGN KEY (`submission_id`) REFERENCES `submission_tab`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user_tab`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_revision_open` ON `submission_revision_tab` (`submission_id`) WHERE "submission_revision_tab"."state" = 'pending';--> statement-breakpoint
CREATE INDEX `submission_revision_state` ON `submission_revision_tab` (`state`,`created_at`);--> statement-breakpoint
ALTER TABLE `submission_tab` ADD `user_id` text REFERENCES user_tab(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
CREATE INDEX `submission_user` ON `submission_tab` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `submission_type_tab` ADD `submit_auth` text DEFAULT 'anonymous' NOT NULL;