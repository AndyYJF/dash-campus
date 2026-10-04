-- Imported notices/decisions/errands are not automatically learning work.
-- Keep every task and its reminders. Classification is owner-correctable and journalled.
ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'auto'
  CHECK (task_kind IN ('auto','study','todo','decision','event','notice','unknown'));
-- Reconcile existing automatic blocks with the new admission gate on the next worker run.
UPDATE planning_state SET planning_revision = planning_revision + 1 WHERE id = 1;
