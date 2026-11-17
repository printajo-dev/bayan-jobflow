-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TemplateVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StageStatus" AS ENUM ('PENDING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'RETURNED', 'CANCELLED');

-- CreateTable
CREATE TABLE "service_types" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_templates" (
    "id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "service_type_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_template_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" "TemplateVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" VARCHAR(2000),
    "created_by_id" UUID,
    "published_by_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workflow_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_template_stages" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "key" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(1000),
    "department_id" UUID NOT NULL,
    "gate_keys" TEXT[],

    CONSTRAINT "workflow_template_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_template_checklists" (
    "id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "label" VARCHAR(300) NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "workflow_template_checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_template_transitions" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "from_stage_id" UUID NOT NULL,
    "to_stage_id" UUID NOT NULL,

    CONSTRAINT "workflow_template_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "job_number" VARCHAR(50) NOT NULL,
    "service_type_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "JobPriority" NOT NULL DEFAULT 'NORMAL',
    "customer_commitment_date" DATE,
    "created_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_briefs" (
    "job_id" UUID NOT NULL,
    "scope" TEXT,
    "requirements" TEXT,
    "notes" TEXT,
    "target_date" DATE,
    "details" JSONB NOT NULL DEFAULT '{}',
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_briefs_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "storage_key" VARCHAR(200) NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(150) NOT NULL,
    "extension" VARCHAR(20) NOT NULL,
    "size" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_files" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "purpose" VARCHAR(30) NOT NULL,
    "added_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_id" UUID,

    CONSTRAINT "job_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_access_logs" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "user_id" UUID,
    "action" VARCHAR(20) NOT NULL,
    "ip" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_workflows" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "template_version_id" UUID NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "job_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_stages" (
    "id" UUID NOT NULL,
    "job_workflow_id" UUID NOT NULL,
    "template_stage_id" UUID NOT NULL,
    "occurrence_no" INTEGER NOT NULL DEFAULT 1,
    "department_id" UUID NOT NULL,
    "status" "StageStatus" NOT NULL DEFAULT 'PENDING',
    "activated_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_id" UUID,
    "returned_from_stage_id" UUID,
    "return_reason" VARCHAR(1000),
    "hold_reason" VARCHAR(1000),
    "exception_reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "department_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_checklist_items" (
    "id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "label" VARCHAR(300) NOT NULL,
    "required" BOOLEAN NOT NULL,
    "checked_at" TIMESTAMPTZ(3),
    "checked_by_id" UUID,

    CONSTRAINT "stage_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_transitions" (
    "id" UUID NOT NULL,
    "job_workflow_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "from_status" "StageStatus",
    "to_status" "StageStatus" NOT NULL,
    "actor_id" UUID,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_types_code_key" ON "service_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_templates_code_key" ON "workflow_templates"("code");

-- CreateIndex
CREATE INDEX "workflow_templates_service_type_id_idx" ON "workflow_templates"("service_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_template_versions_template_id_version_no_key" ON "workflow_template_versions"("template_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_template_stages_version_id_sequence_key" ON "workflow_template_stages"("version_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_template_stages_version_id_key_key" ON "workflow_template_stages"("version_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_template_checklists_stage_id_sequence_key" ON "workflow_template_checklists"("stage_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_template_transitions_from_stage_id_to_stage_id_key" ON "workflow_template_transitions"("from_stage_id", "to_stage_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_job_number_key" ON "jobs"("job_number");

-- CreateIndex
CREATE INDEX "jobs_status_service_type_id_idx" ON "jobs"("status", "service_type_id");

-- CreateIndex
CREATE INDEX "jobs_created_at_idx" ON "jobs"("created_at");

-- CreateIndex
CREATE INDEX "jobs_customer_commitment_date_idx" ON "jobs"("customer_commitment_date");

-- CreateIndex
CREATE UNIQUE INDEX "files_storage_key_key" ON "files"("storage_key");

-- CreateIndex
CREATE INDEX "job_files_job_id_idx" ON "job_files"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_files_job_id_file_id_key" ON "job_files"("job_id", "file_id");

-- CreateIndex
CREATE INDEX "file_access_logs_file_id_idx" ON "file_access_logs"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_workflows_job_id_key" ON "job_workflows"("job_id");

-- CreateIndex
CREATE INDEX "job_workflows_template_version_id_idx" ON "job_workflows"("template_version_id");

-- CreateIndex
CREATE INDEX "department_stages_status_department_id_idx" ON "department_stages"("status", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "department_stages_job_workflow_id_template_stage_id_occurre_key" ON "department_stages"("job_workflow_id", "template_stage_id", "occurrence_no");

-- CreateIndex
CREATE UNIQUE INDEX "stage_checklist_items_stage_id_sequence_key" ON "stage_checklist_items"("stage_id", "sequence");

-- CreateIndex
CREATE INDEX "workflow_transitions_job_workflow_id_created_at_idx" ON "workflow_transitions"("job_workflow_id", "created_at");

-- AddForeignKey
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_versions" ADD CONSTRAINT "workflow_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_stages" ADD CONSTRAINT "workflow_template_stages_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "workflow_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_stages" ADD CONSTRAINT "workflow_template_stages_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_checklists" ADD CONSTRAINT "workflow_template_checklists_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "workflow_template_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_transitions" ADD CONSTRAINT "workflow_template_transitions_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "workflow_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_transitions" ADD CONSTRAINT "workflow_template_transitions_from_stage_id_fkey" FOREIGN KEY ("from_stage_id") REFERENCES "workflow_template_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_transitions" ADD CONSTRAINT "workflow_template_transitions_to_stage_id_fkey" FOREIGN KEY ("to_stage_id") REFERENCES "workflow_template_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_briefs" ADD CONSTRAINT "job_briefs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_files" ADD CONSTRAINT "job_files_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_files" ADD CONSTRAINT "job_files_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_access_logs" ADD CONSTRAINT "file_access_logs_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_workflows" ADD CONSTRAINT "job_workflows_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_workflows" ADD CONSTRAINT "job_workflows_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "workflow_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_stages" ADD CONSTRAINT "department_stages_job_workflow_id_fkey" FOREIGN KEY ("job_workflow_id") REFERENCES "job_workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_stages" ADD CONSTRAINT "department_stages_template_stage_id_fkey" FOREIGN KEY ("template_stage_id") REFERENCES "workflow_template_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_stages" ADD CONSTRAINT "department_stages_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_stages" ADD CONSTRAINT "department_stages_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_stages" ADD CONSTRAINT "department_stages_returned_from_stage_id_fkey" FOREIGN KEY ("returned_from_stage_id") REFERENCES "department_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_checklist_items" ADD CONSTRAINT "stage_checklist_items_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "department_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_checklist_items" ADD CONSTRAINT "stage_checklist_items_checked_by_id_fkey" FOREIGN KEY ("checked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_job_workflow_id_fkey" FOREIGN KEY ("job_workflow_id") REFERENCES "job_workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "department_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- Integrity rules

-- At most one published version per template.
CREATE UNIQUE INDEX "workflow_template_versions_one_published"
  ON "workflow_template_versions" ("template_id") WHERE "status" = 'PUBLISHED';

-- Job Numbers are stored normalised (upper-case, trimmed) so uniqueness is case-insensitive.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_job_number_normalised"
  CHECK ("job_number" = upper(btrim("job_number")) AND "job_number" <> '');

-- Published and retired template versions are immutable. The only allowed
-- change is PUBLISHED -> RETIRED when a newer version is published.
CREATE OR REPLACE FUNCTION jobflow_protect_template_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Published template versions cannot be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED'
     AND NEW.template_id = OLD.template_id AND NEW.version_no = OLD.version_no
     AND NEW.notes IS NOT DISTINCT FROM OLD.notes
     AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Template version % is % and cannot be changed', OLD.version_no, OLD.status
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_template_versions_protect
  BEFORE UPDATE OR DELETE ON "workflow_template_versions"
  FOR EACH ROW EXECUTE FUNCTION jobflow_protect_template_version();

-- Stages, checklists and return rules may change only while their version is a draft.
CREATE OR REPLACE FUNCTION jobflow_require_draft_version() RETURNS trigger AS $$
DECLARE
  v_version uuid;
  v_status text;
  v_row record;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_TABLE_NAME = 'workflow_template_checklists' THEN
    SELECT version_id INTO v_version FROM workflow_template_stages WHERE id = v_row.stage_id;
  ELSE
    v_version := v_row.version_id;
  END IF;
  SELECT status INTO v_status FROM workflow_template_versions WHERE id = v_version;
  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Template version is % and cannot be changed', v_status USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_row;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_template_stages_require_draft
  BEFORE INSERT OR UPDATE OR DELETE ON "workflow_template_stages"
  FOR EACH ROW EXECUTE FUNCTION jobflow_require_draft_version();
CREATE TRIGGER workflow_template_checklists_require_draft
  BEFORE INSERT OR UPDATE OR DELETE ON "workflow_template_checklists"
  FOR EACH ROW EXECUTE FUNCTION jobflow_require_draft_version();
CREATE TRIGGER workflow_template_transitions_require_draft
  BEFORE INSERT OR UPDATE OR DELETE ON "workflow_template_transitions"
  FOR EACH ROW EXECUTE FUNCTION jobflow_require_draft_version();

-- Workflow history and file access logs are append-only.
CREATE TRIGGER workflow_transitions_append_only
  BEFORE UPDATE OR DELETE ON "workflow_transitions"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_modification();
CREATE TRIGGER file_access_logs_append_only
  BEFORE UPDATE OR DELETE ON "file_access_logs"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_modification();
