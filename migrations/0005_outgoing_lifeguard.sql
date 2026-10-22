CREATE TABLE `oauth_state_tab` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_state_expires` ON `oauth_state_tab` (`expires_at`);--> statement-breakpoint
ALTER TABLE `contributor_tab` ADD `handle` text;