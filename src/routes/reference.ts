import { Router } from "express";
import { pool } from "../db";

const router = Router();

async function listRef(table: string) {
  // table is internal constant in our code (not user input), safe to interpolate
  const sql = `SELECT id, name, description FROM ${table} ORDER BY id ASC;`;
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

export default router;
