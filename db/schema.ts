import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
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

export const reviewHistory = sqliteTable(
  'review_history',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    turnId: text('turn_id').notNull(),
    action: text('action').notNull(),
    data: text('data').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('review_history_turn_idx').on(table.taskId, table.turnId)],
);

export const exportBatches = sqliteTable('export_batches', {
  id: text('id').primaryKey(),
  nonce: text('nonce').notNull(),
  filter: text('filter').notNull(),
  createdAt: text('created_at').notNull(),
});
export const exportItems = sqliteTable(
  'export_items',
  {
    batchId: text('batch_id').notNull(),
    taskId: text('task_id').notNull(),
    turnId: text('turn_id').notNull(),
    source: text('source').notNull(),
    snapshot: text('snapshot').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.batchId, t.taskId, t.turnId] }),
    index('export_items_turn_idx').on(t.taskId, t.turnId),
  ],
);

// Stable project numbers survive task edits and are never reused after deletion.
export const projectNames = sqliteTable('project_names', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  taskId: text('task_id').notNull().unique(),
});

// Immutable materialized views; original jobs/evidence remain authoritative.
export const deliveryIndexes = sqliteTable(
  'delivery_indexes',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    data: text('data').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.version] }),
    index('delivery_indexes_history_idx').on(t.taskId, t.createdAt),
  ],
);
