import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  data: text('data').notNull(),
  revision: integer('revision').notNull().default(0),
  createdAt: text('created_at').notNull(),
});
export const runners = sqliteTable('runners', {
  id: text('id').primaryKey(),
  data: text('data').notNull(),
  heartbeat: text('heartbeat').notNull(),
});
