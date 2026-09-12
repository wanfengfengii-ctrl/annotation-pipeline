CREATE TABLE `delivery_indexes` (
	`task_id` text NOT NULL,
	`version` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`task_id`, `version`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `delivery_indexes_history_idx` ON `delivery_indexes` (`task_id`,`created_at`);