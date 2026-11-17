-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'ASSIGNED', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalMethod" AS ENUM ('IN_PERSON', 'EMAIL', 'WHATSAPP', 'PHONE', 'SIGNED_FORM', 'OTHER');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('DEPARTMENT', 'GENERAL');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "CorrectionStatus" AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_INFO', 'RESOLVED', 'REOPENED');

-- AlterTable
ALTER TABLE "department_stages" ADD COLUMN     "internal_deadline" DATE;

-- AlterTable
ALTER TABLE "files" ADD COLUMN     "duration_sec" INTEGER;

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "priority" "JobPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "start_date" DATE,
    "due_date" DATE,
    "created_by_id" UUID,
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_assignments" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "assigned_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_id" UUID,

    CONSTRAINT "task_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_dependencies" (
    "task_id" UUID NOT NULL,
    "depends_on_task_id" UUID NOT NULL,

    CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("task_id","depends_on_task_id")
);

-- CreateTable
CREATE TABLE "task_checklist_items" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "label" VARCHAR(300) NOT NULL,
    "done_at" TIMESTAMPTZ(3),
    "done_by_id" UUID,

    CONSTRAINT "task_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_comments" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "author_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correction_rounds" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "round_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "source_message_id" UUID,
    "requested_by_id" UUID,
    "assigned_designer_id" UUID,
    "deadline" DATE,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correction_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correction_round_files" (
    "round_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,

    CONSTRAINT "correction_round_files_pkey" PRIMARY KEY ("round_id","file_id")
);

-- CreateTable
CREATE TABLE "artwork_versions" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "file_id" UUID NOT NULL,
    "stage_id" UUID,
    "correction_round_id" UUID,
    "notes" VARCHAR(2000),
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artwork_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_records" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "artwork_version_id" UUID NOT NULL,
    "approver_name" VARCHAR(150) NOT NULL,
    "approver_role" VARCHAR(150),
    "method" "ApprovalMethod" NOT NULL,
    "approved_at" TIMESTAMPTZ(3) NOT NULL,
    "notes" VARCHAR(2000),
    "evidence_file_id" UUID,
    "recorded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discussion_channels" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "type" "ChannelType" NOT NULL,
    "department_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discussion_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discussion_channel_members" (
    "channel_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "added_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discussion_channel_members_pkey" PRIMARY KEY ("channel_id","user_id")
);

-- CreateTable
CREATE TABLE "discussion_messages" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "parent_message_id" UUID,
    "stage_id" UUID,
    "kind" "MessageKind" NOT NULL DEFAULT 'USER',
    "author_id" UUID,
    "body" TEXT NOT NULL DEFAULT '',
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discussion_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discussion_attachments" (
    "message_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "is_voice" BOOLEAN NOT NULL DEFAULT false,
    "duration_sec" INTEGER,

    CONSTRAINT "discussion_attachments_pkey" PRIMARY KEY ("message_id","file_id")
);

-- CreateTable
CREATE TABLE "discussion_mentions" (
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "discussion_mentions_pkey" PRIMARY KEY ("message_id","user_id")
);

-- CreateTable
CREATE TABLE "discussion_reactions" (
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "emoji" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discussion_reactions_pkey" PRIMARY KEY ("message_id","user_id","emoji")
);

-- CreateTable
CREATE TABLE "discussion_read_receipts" (
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discussion_read_receipts_pkey" PRIMARY KEY ("message_id","user_id")
);

-- CreateTable
CREATE TABLE "discussion_pins" (
    "channel_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "pinned_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discussion_pins_pkey" PRIMARY KEY ("channel_id","message_id")
);

-- CreateTable
CREATE TABLE "discussion_message_edits" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "previous_body" TEXT NOT NULL,
    "action" VARCHAR(10) NOT NULL,
    "edited_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discussion_message_edits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correction_items" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "stage_id" UUID,
    "channel_id" UUID,
    "source_message_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL,
    "requested_by_id" UUID,
    "assigned_to_id" UUID,
    "priority" "JobPriority" NOT NULL DEFAULT 'NORMAL',
    "deadline" DATE,
    "status" "CorrectionStatus" NOT NULL DEFAULT 'OPEN',
    "blocking" BOOLEAN NOT NULL DEFAULT true,
    "resolution_notes" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "correction_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correction_status_history" (
    "id" UUID NOT NULL,
    "correction_id" UUID NOT NULL,
    "from_status" "CorrectionStatus",
    "to_status" "CorrectionStatus" NOT NULL,
    "actor_id" UUID,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correction_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correction_files" (
    "correction_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,

    CONSTRAINT "correction_files_pkey" PRIMARY KEY ("correction_id","file_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "event_key" VARCHAR(200) NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "body" VARCHAR(1000),
    "link" VARCHAR(300),
    "job_id" UUID,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id","type")
);

-- CreateIndex
CREATE INDEX "tasks_job_id_idx" ON "tasks"("job_id");

-- CreateIndex
CREATE INDEX "tasks_stage_id_idx" ON "tasks"("stage_id");

-- CreateIndex
CREATE INDEX "tasks_department_id_status_idx" ON "tasks"("department_id", "status");

-- CreateIndex
CREATE INDEX "tasks_due_date_idx" ON "tasks"("due_date");

-- CreateIndex
CREATE INDEX "task_assignments_user_id_idx" ON "task_assignments"("user_id");

-- CreateIndex
CREATE INDEX "task_assignments_task_id_idx" ON "task_assignments"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_checklist_items_task_id_sequence_key" ON "task_checklist_items"("task_id", "sequence");

-- CreateIndex
CREATE INDEX "task_comments_task_id_idx" ON "task_comments"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "correction_rounds_job_id_round_no_key" ON "correction_rounds"("job_id", "round_no");

-- CreateIndex
CREATE UNIQUE INDEX "artwork_versions_job_id_version_no_key" ON "artwork_versions"("job_id", "version_no");

-- CreateIndex
CREATE INDEX "approval_records_artwork_version_id_idx" ON "approval_records"("artwork_version_id");

-- CreateIndex
CREATE INDEX "discussion_channels_job_id_idx" ON "discussion_channels"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "discussion_channels_job_id_department_id_key" ON "discussion_channels"("job_id", "department_id");

-- CreateIndex
CREATE INDEX "discussion_messages_channel_id_created_at_idx" ON "discussion_messages"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "discussion_messages_parent_message_id_idx" ON "discussion_messages"("parent_message_id");

-- CreateIndex
CREATE INDEX "discussion_read_receipts_user_id_idx" ON "discussion_read_receipts"("user_id");

-- CreateIndex
CREATE INDEX "discussion_message_edits_message_id_idx" ON "discussion_message_edits"("message_id");

-- CreateIndex
CREATE INDEX "correction_items_job_id_idx" ON "correction_items"("job_id");

-- CreateIndex
CREATE INDEX "correction_items_assigned_to_id_status_idx" ON "correction_items"("assigned_to_id", "status");

-- CreateIndex
CREATE INDEX "correction_status_history_correction_id_idx" ON "correction_status_history"("correction_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_event_key_key" ON "notifications"("user_id", "event_key");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "department_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_fkey" FOREIGN KEY ("depends_on_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_rounds" ADD CONSTRAINT "correction_rounds_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_rounds" ADD CONSTRAINT "correction_rounds_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_rounds" ADD CONSTRAINT "correction_rounds_assigned_designer_id_fkey" FOREIGN KEY ("assigned_designer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_round_files" ADD CONSTRAINT "correction_round_files_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "correction_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_round_files" ADD CONSTRAINT "correction_round_files_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_versions" ADD CONSTRAINT "artwork_versions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_versions" ADD CONSTRAINT "artwork_versions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_versions" ADD CONSTRAINT "artwork_versions_correction_round_id_fkey" FOREIGN KEY ("correction_round_id") REFERENCES "correction_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_versions" ADD CONSTRAINT "artwork_versions_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_records" ADD CONSTRAINT "approval_records_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_records" ADD CONSTRAINT "approval_records_artwork_version_id_fkey" FOREIGN KEY ("artwork_version_id") REFERENCES "artwork_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_records" ADD CONSTRAINT "approval_records_evidence_file_id_fkey" FOREIGN KEY ("evidence_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_records" ADD CONSTRAINT "approval_records_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_channels" ADD CONSTRAINT "discussion_channels_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_channels" ADD CONSTRAINT "discussion_channels_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_channel_members" ADD CONSTRAINT "discussion_channel_members_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "discussion_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_channel_members" ADD CONSTRAINT "discussion_channel_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "discussion_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_parent_message_id_fkey" FOREIGN KEY ("parent_message_id") REFERENCES "discussion_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_attachments" ADD CONSTRAINT "discussion_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "discussion_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_attachments" ADD CONSTRAINT "discussion_attachments_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_mentions" ADD CONSTRAINT "discussion_mentions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "discussion_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_mentions" ADD CONSTRAINT "discussion_mentions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_reactions" ADD CONSTRAINT "discussion_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "discussion_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_read_receipts" ADD CONSTRAINT "discussion_read_receipts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "discussion_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_pins" ADD CONSTRAINT "discussion_pins_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "discussion_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_pins" ADD CONSTRAINT "discussion_pins_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "discussion_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_message_edits" ADD CONSTRAINT "discussion_message_edits_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "discussion_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_items" ADD CONSTRAINT "correction_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_items" ADD CONSTRAINT "correction_items_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_items" ADD CONSTRAINT "correction_items_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_items" ADD CONSTRAINT "correction_items_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_status_history" ADD CONSTRAINT "correction_status_history_correction_id_fkey" FOREIGN KEY ("correction_id") REFERENCES "correction_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_files" ADD CONSTRAINT "correction_files_correction_id_fkey" FOREIGN KEY ("correction_id") REFERENCES "correction_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_files" ADD CONSTRAINT "correction_files_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- Integrity rules
-- One General channel per job (department_id is NULL for it).
CREATE UNIQUE INDEX "discussion_channels_one_general" ON "discussion_channels" ("job_id") WHERE "type" = 'GENERAL';
ALTER TABLE "discussion_channels" ADD CONSTRAINT "discussion_channels_department_matches_type"
  CHECK (("type" = 'GENERAL') = ("department_id" IS NULL));

-- Message search.
CREATE INDEX "discussion_messages_body_search" ON "discussion_messages" USING GIN (to_tsvector('simple', "body"));

-- History that must never change: artwork versions, customer approvals,
-- message edit history and correction status history.
CREATE TRIGGER artwork_versions_append_only BEFORE UPDATE OR DELETE ON "artwork_versions"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_modification();
CREATE TRIGGER approval_records_append_only BEFORE UPDATE OR DELETE ON "approval_records"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_modification();
CREATE TRIGGER discussion_message_edits_append_only BEFORE UPDATE OR DELETE ON "discussion_message_edits"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_modification();
CREATE TRIGGER correction_status_history_append_only BEFORE UPDATE OR DELETE ON "correction_status_history"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_modification();
-- Messages are soft-deleted only.
CREATE OR REPLACE FUNCTION jobflow_forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Rows in % cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER discussion_messages_no_delete BEFORE DELETE ON "discussion_messages"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_delete();
CREATE TRIGGER correction_items_no_delete BEFORE DELETE ON "correction_items"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_delete();
CREATE TRIGGER tasks_no_delete BEFORE DELETE ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_delete();
