-- CreateEnum
CREATE TYPE "AuthorityStatus" AS ENUM ('NOT_REQUIRED', 'PENDING_PREPARATION', 'READY_TO_SUBMIT', 'SUBMITTED', 'UNDER_REVIEW', 'MORE_INFO_REQUIRED', 'REJECTED', 'APPROVED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('NOT_DUE', 'PENDING', 'PAID', 'WAIVED');

-- CreateEnum
CREATE TYPE "SubmissionOutcome" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'MORE_INFO');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'RESCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductionStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InstallationStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'PARTIAL', 'BLOCKED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "authority_types" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authority_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_applications" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "authority_type_id" UUID NOT NULL,
    "status" "AuthorityStatus" NOT NULL DEFAULT 'PENDING_PREPARATION',
    "reference_number" VARCHAR(100),
    "submission_date" TIMESTAMPTZ(3),
    "expected_response_date" DATE,
    "actual_response_date" TIMESTAMPTZ(3),
    "valid_until" DATE,
    "fees" DECIMAL(12,2),
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'NOT_DUE',
    "rejection_reason" VARCHAR(2000),
    "not_required_reason" VARCHAR(1000),
    "not_required_by_id" UUID,
    "comments" VARCHAR(2000),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "authority_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_submissions" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "submission_no" INTEGER NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "reference_number" VARCHAR(100),
    "outcome" "SubmissionOutcome" NOT NULL DEFAULT 'PENDING',
    "outcome_at" TIMESTAMPTZ(3),
    "outcome_notes" VARCHAR(2000),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authority_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_documents" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authority_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_payments" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paid_at" TIMESTAMPTZ(3) NOT NULL,
    "reference" VARCHAR(100),
    "receipt_file_id" UUID,
    "recorded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authority_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_status_history" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "from_status" "AuthorityStatus",
    "to_status" "AuthorityStatus" NOT NULL,
    "actor_id" UUID,
    "note" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authority_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_schedules" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "vehicle_ref" VARCHAR(200) NOT NULL,
    "planned_start" TIMESTAMPTZ(3) NOT NULL,
    "planned_end" TIMESTAMPTZ(3),
    "location" VARCHAR(300) NOT NULL,
    "notes" VARCHAR(2000),
    "status" "ScheduleStatus" NOT NULL DEFAULT 'PROPOSED',
    "confirmation_note" VARCHAR(500),
    "confirmed_by_id" UUID,
    "confirmed_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicle_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_schedule_history" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "action" VARCHAR(30) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "actor_id" UUID,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_schedule_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machines" (
    "id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "kind" VARCHAR(50),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_orders" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "activity" VARCHAR(30) NOT NULL DEFAULT 'PRINTING',
    "artwork_version_id" UUID,
    "material" VARCHAR(200),
    "quantity" INTEGER,
    "dimensions" VARCHAR(200),
    "machine_id" UUID,
    "operator_id" UUID,
    "planned_start" TIMESTAMPTZ(3),
    "planned_finish" TIMESTAMPTZ(3),
    "actual_start" TIMESTAMPTZ(3),
    "actual_finish" TIMESTAMPTZ(3),
    "status" "ProductionStatus" NOT NULL DEFAULT 'PLANNED',
    "wastage_notes" VARCHAR(2000),
    "notes" VARCHAR(2000),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installation_orders" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "target" VARCHAR(300) NOT NULL,
    "address" VARCHAR(500),
    "access_notes" VARCHAR(2000),
    "safety_notes" VARCHAR(2000),
    "instructions" VARCHAR(5000),
    "scheduled_start" TIMESTAMPTZ(3),
    "scheduled_end" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "team_leader_id" UUID,
    "status" "InstallationStatus" NOT NULL DEFAULT 'SCHEDULED',
    "issues" VARCHAR(5000),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "installation_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installation_assignments" (
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "installation_assignments_pkey" PRIMARY KEY ("order_id","user_id")
);

-- CreateTable
CREATE TABLE "installation_materials" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "item" VARCHAR(200) NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit" VARCHAR(20),

    CONSTRAINT "installation_materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_logs" (
    "id" UUID NOT NULL,
    "production_order_id" UUID,
    "installation_order_id" UUID,
    "note" VARCHAR(2000) NOT NULL,
    "quantity_done" INTEGER,
    "status" VARCHAR(30),
    "file_ids" UUID[],
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "authority_types_code_key" ON "authority_types"("code");

-- CreateIndex
CREATE INDEX "authority_applications_status_idx" ON "authority_applications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "authority_applications_job_id_authority_type_id_key" ON "authority_applications"("job_id", "authority_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "authority_submissions_application_id_submission_no_key" ON "authority_submissions"("application_id", "submission_no");

-- CreateIndex
CREATE UNIQUE INDEX "authority_documents_application_id_file_id_key" ON "authority_documents"("application_id", "file_id");

-- CreateIndex
CREATE INDEX "authority_status_history_application_id_idx" ON "authority_status_history"("application_id");

-- CreateIndex
CREATE INDEX "vehicle_schedules_job_id_idx" ON "vehicle_schedules"("job_id");

-- CreateIndex
CREATE INDEX "vehicle_schedules_planned_start_idx" ON "vehicle_schedules"("planned_start");

-- CreateIndex
CREATE INDEX "vehicle_schedule_history_schedule_id_idx" ON "vehicle_schedule_history"("schedule_id");

-- CreateIndex
CREATE UNIQUE INDEX "machines_code_key" ON "machines"("code");

-- CreateIndex
CREATE INDEX "production_orders_job_id_idx" ON "production_orders"("job_id");

-- CreateIndex
CREATE INDEX "production_orders_stage_id_idx" ON "production_orders"("stage_id");

-- CreateIndex
CREATE INDEX "production_orders_status_idx" ON "production_orders"("status");

-- CreateIndex
CREATE INDEX "installation_orders_job_id_idx" ON "installation_orders"("job_id");

-- CreateIndex
CREATE INDEX "installation_orders_stage_id_idx" ON "installation_orders"("stage_id");

-- CreateIndex
CREATE INDEX "installation_orders_scheduled_start_idx" ON "installation_orders"("scheduled_start");

-- CreateIndex
CREATE INDEX "operation_logs_production_order_id_idx" ON "operation_logs"("production_order_id");

-- CreateIndex
CREATE INDEX "operation_logs_installation_order_id_idx" ON "operation_logs"("installation_order_id");

-- AddForeignKey
ALTER TABLE "authority_applications" ADD CONSTRAINT "authority_applications_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authority_applications" ADD CONSTRAINT "authority_applications_authority_type_id_fkey" FOREIGN KEY ("authority_type_id") REFERENCES "authority_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authority_submissions" ADD CONSTRAINT "authority_submissions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "authority_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authority_documents" ADD CONSTRAINT "authority_documents_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "authority_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authority_documents" ADD CONSTRAINT "authority_documents_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authority_payments" ADD CONSTRAINT "authority_payments_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "authority_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authority_status_history" ADD CONSTRAINT "authority_status_history_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "authority_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_schedules" ADD CONSTRAINT "vehicle_schedules_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_schedule_history" ADD CONSTRAINT "vehicle_schedule_history_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "vehicle_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "department_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installation_orders" ADD CONSTRAINT "installation_orders_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installation_orders" ADD CONSTRAINT "installation_orders_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "department_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installation_orders" ADD CONSTRAINT "installation_orders_team_leader_id_fkey" FOREIGN KEY ("team_leader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installation_assignments" ADD CONSTRAINT "installation_assignments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "installation_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installation_assignments" ADD CONSTRAINT "installation_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installation_materials" ADD CONSTRAINT "installation_materials_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "installation_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_logs" ADD CONSTRAINT "operation_logs_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_logs" ADD CONSTRAINT "operation_logs_installation_order_id_fkey" FOREIGN KEY ("installation_order_id") REFERENCES "installation_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- History tables are append-only; operational records are never hard-deleted.
CREATE TRIGGER authority_status_history_append_only BEFORE UPDATE OR DELETE ON "authority_status_history"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_modification();
CREATE TRIGGER authority_payments_append_only BEFORE UPDATE OR DELETE ON "authority_payments"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_modification();
CREATE TRIGGER vehicle_schedule_history_append_only BEFORE UPDATE OR DELETE ON "vehicle_schedule_history"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_modification();
CREATE TRIGGER operation_logs_append_only BEFORE UPDATE OR DELETE ON "operation_logs"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_modification();
CREATE TRIGGER authority_submissions_no_delete BEFORE DELETE ON "authority_submissions"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_delete();
CREATE TRIGGER authority_documents_no_delete BEFORE DELETE ON "authority_documents"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_delete();
CREATE TRIGGER authority_applications_no_delete BEFORE DELETE ON "authority_applications"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_delete();
CREATE TRIGGER production_orders_no_delete BEFORE DELETE ON "production_orders"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_delete();
CREATE TRIGGER installation_orders_no_delete BEFORE DELETE ON "installation_orders"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_delete();
CREATE TRIGGER vehicle_schedules_no_delete BEFORE DELETE ON "vehicle_schedules"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_delete();
ALTER TABLE "operation_logs" ADD CONSTRAINT "operation_logs_one_parent"
  CHECK (("production_order_id" IS NULL) <> ("installation_order_id" IS NULL));
