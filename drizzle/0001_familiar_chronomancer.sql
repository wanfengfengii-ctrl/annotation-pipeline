CREATE TABLE `review_history` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`action` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `review_history_turn_idx` ON `review_history` (`task_id`,`turn_id`);