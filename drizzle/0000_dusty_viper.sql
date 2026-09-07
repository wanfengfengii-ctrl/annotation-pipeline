CREATE TABLE `runners` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`heartbeat` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
