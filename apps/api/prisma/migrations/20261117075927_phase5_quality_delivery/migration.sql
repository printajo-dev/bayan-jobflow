-- CreateEnum
CREATE TYPE "QcStatus" AS ENUM ('DRAFT', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "QcResult" AS ENUM ('PASS', 'FAIL', 'NA');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PLANNED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "qc_checklist_templates" (
    "id" UUID NOT NULL,
    "service_type_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "version" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qc_checklist_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_checklist_template_items" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "label" VARCHAR(300) NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "requires_evidence" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "qc_checklist_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_inspections" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "status" "QcStatus" NOT NULL DEFAULT 'DRAFT',
    "inspector_id" UUID,
    "inspected_at" TIMESTAMPTZ(3),
    "notes" VARCHAR(5000),
    "defects" VARCHAR(5000),
    "responsible_stage_key" VARCHAR(50),
    "correction_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "qc_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_checklist_results" (
    "id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "label" VARCHAR(300) NOT NULL,
    "required" BOOLEAN NOT NULL,
    "requires_evidence" BOOLEAN NOT NULL,
    "result" "QcResult",
    "comment" VARCHAR(1000),
    "file_ids" UUID[],

    CONSTRAINT "qc_checklist_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_records" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "planned_at" TIMESTAMPTZ(3) NOT NULL,
    "actual_at" TIMESTAMPTZ(3),
    "recipient_name" VARCHAR(150),
    "handover_notes" VARCHAR(5000),
    "notes" VARCHAR(2000),
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PLANNED',
    "file_ids" UUID[],
    "completed_by_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "delivery_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "qc_checklist_templates_service_type_id_version_key" ON "qc_checklist_templates"("service_type_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "qc_checklist_template_items_template_id_sequence_key" ON "qc_checklist_template_items"("template_id", "sequence");

-- CreateIndex
CREATE INDEX "qc_inspections_job_id_idx" ON "qc_inspections"("job_id");

-- CreateIndex
CREATE INDEX "qc_inspections_stage_id_idx" ON "qc_inspections"("stage_id");

-- CreateIndex
CREATE INDEX "qc_inspections_status_idx" ON "qc_inspections"("status");

-- CreateIndex
CREATE UNIQUE INDEX "qc_checklist_results_inspection_id_item_id_key" ON "qc_checklist_results"("inspection_id", "item_id");

-- CreateIndex
CREATE INDEX "delivery_records_job_id_idx" ON "delivery_records"("job_id");

-- CreateIndex
CREATE INDEX "delivery_records_planned_at_idx" ON "delivery_records"("planned_at");

-- AddForeignKey
ALTER TABLE "qc_checklist_templates" ADD CONSTRAINT "qc_checklist_templates_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_checklist_template_items" ADD CONSTRAINT "qc_checklist_template_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "qc_checklist_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_inspections" ADD CONSTRAINT "qc_inspections_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_inspections" ADD CONSTRAINT "qc_inspections_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "department_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_inspections" ADD CONSTRAINT "qc_inspections_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "qc_checklist_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_checklist_results" ADD CONSTRAINT "qc_checklist_results_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "qc_inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_records" ADD CONSTRAINT "delivery_records_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_records" ADD CONSTRAINT "delivery_records_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "department_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A submitted inspection (passed or failed) is a permanent record; re-inspection creates a new row.
CREATE OR REPLACE FUNCTION jobflow_protect_qc_inspection() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'QC inspections cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'A submitted QC inspection cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER qc_inspections_protect BEFORE UPDATE OR DELETE ON "qc_inspections"
  FOR EACH ROW EXECUTE FUNCTION jobflow_protect_qc_inspection();

CREATE OR REPLACE FUNCTION jobflow_protect_qc_result() RETURNS trigger AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM qc_inspections WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.inspection_id ELSE NEW.inspection_id END;
  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Results of a submitted QC inspection cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER qc_checklist_results_protect BEFORE INSERT OR UPDATE OR DELETE ON "qc_checklist_results"
  FOR EACH ROW EXECUTE FUNCTION jobflow_protect_qc_result();

CREATE TRIGGER delivery_records_no_delete BEFORE DELETE ON "delivery_records"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_delete();
CREATE TRIGGER qc_templates_no_delete BEFORE DELETE ON "qc_checklist_templates"
  FOR EACH ROW EXECUTE FUNCTION jobflow_forbid_delete();
