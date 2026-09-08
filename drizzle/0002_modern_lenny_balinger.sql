CREATE TABLE `export_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`filter` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `export_items` (
	`batch_id` text NOT NULL,
	`task_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`source` text NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`batch_id`, `task_id`, `turn_id`)
);
--> statement-breakpoint
CREATE INDEX `export_items_turn_idx` ON `export_items` (`task_id`,`turn_id`);