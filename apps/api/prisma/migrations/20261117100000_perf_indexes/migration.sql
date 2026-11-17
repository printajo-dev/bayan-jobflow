-- Dashboard and department queues: open corrections per department.
CREATE INDEX "correction_items_department_id_status_idx" ON "correction_items"("department_id", "status");

-- Notification list: newest first per user.
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);

-- One active assignment per user and task (duplicate ids in a request, or two
-- leaders assigning at once, cannot create two rows).
UPDATE "task_assignments" a SET "removed_at" = now()
WHERE a."removed_at" IS NULL
  AND EXISTS (SELECT 1 FROM "task_assignments" b
              WHERE b."task_id" = a."task_id" AND b."user_id" = a."user_id" AND b."removed_at" IS NULL AND b."id" < a."id");
CREATE UNIQUE INDEX "task_assignments_active_uq" ON "task_assignments"("task_id", "user_id") WHERE "removed_at" IS NULL;
