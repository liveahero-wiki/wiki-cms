ALTER TABLE `submission_type_tab` ADD `discord_webhook_url` text;--> statement-breakpoint
ALTER TABLE `submission_type_tab` ADD `discord_thread_id` text;--> statement-breakpoint
ALTER TABLE `submission_type_tab` ADD `webhook_per_hour` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `submission_type_tab` ADD `webhook_window_start` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `submission_type_tab` ADD `webhook_window_count` integer DEFAULT 0 NOT NULL;