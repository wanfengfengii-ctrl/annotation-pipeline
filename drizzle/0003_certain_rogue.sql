CREATE TABLE `project_names` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_names_task_id_unique` ON `project_names` (`task_id`);
--> statement-breakpoint
INSERT INTO project_names(task_id)
SELECT id FROM tasks ORDER BY created_at ASC, id ASC;
--> statement-breakpoint
CREATE TRIGGER tasks_assign_project_name AFTER INSERT ON tasks
BEGIN
  INSERT INTO project_names(task_id) VALUES (NEW.id);
END;
