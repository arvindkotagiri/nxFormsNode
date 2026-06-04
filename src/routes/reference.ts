import { Router } from "express";
import { pool } from "../db";
import { AUDIT_SELECT_SQL } from "../utils/audit";

const router = Router();

async function listRef(table: string) {
  const sql = `SELECT id, name, description, ${AUDIT_SELECT_SQL} FROM ${table} ORDER BY id ASC;`;
  const result = await pool.query(sql);
  return result.rows;
}

async function listForms(table: string) {
  const sql = `SELECT label_id as id, label_name as name, context, field_mapping, ${AUDIT_SELECT_SQL} FROM ${table} ORDER BY created_on DESC NULLS LAST;`;
  const result = await pool.query(sql);
  return result.rows;
}

async function listFormsPrinters(table: string) {
  const sql = `SELECT id, name, ${AUDIT_SELECT_SQL} FROM ${table} ORDER BY created_on DESC NULLS LAST;`;
  const result = await pool.query(sql);
  return result.rows;
}

router.get("/customers", async (_req, res) => {
  res.json(await listRef("ref_customers"));
});

router.get("/plants", async (_req, res) => {
  res.json(await listRef("ref_plants"));
});

router.get("/company-codes", async (_req, res) => {
  res.json(await listRef("ref_company_codes"));
});

router.get("/sales-orgs", async (_req, res) => {
  res.json(await listRef("ref_sales_orgs"));
});

router.get("/warehouses", async (_req, res) => {
  res.json(await listRef("ref_warehouses"));
});

router.get("/shipping-points", async (_req, res) => {
  res.json(await listRef("ref_shipping_points"));
});

router.get("/process-types", async (_req, res) => {
  res.json(await listRef("ref_process_types"));
});

router.get("/labels", async (_req, res) => {
  res.json(await listRef("ref_labels"));
});

router.get("/all-labels", async (_req, res) => {
  res.json(await listForms("label_master"));
});

router.get("/printers", async (_req, res) => {
  res.json(await listFormsPrinters("printer_master"));
});

export default router;
