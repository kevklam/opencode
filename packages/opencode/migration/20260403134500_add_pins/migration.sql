CREATE TABLE `pin` (
	`session_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`start_line` integer,
	`start_column` integer,
	`end_line` integer,
	`end_column` integer,
	`position` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	PRIMARY KEY(`session_id`, `id`),
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pin_session_idx` ON `pin` (`session_id`);
