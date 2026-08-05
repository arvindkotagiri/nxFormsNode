import { Router } from "express";
import { pool } from "../db";
import { auditActor, AUDIT_SELECT_SQL } from "../utils/audit";
import { buildEncryptedPayload, maybeDecryptPayload } from "../utils/dataEncryption";
import type { AuthedRequest } from "../middleware/auth";

const router = Router();

/**
 * GET /api/simulation
 * Returns all simulation master records
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        simulation_name,
        context,
        form,
        input_values,
        encrypted_payload,
        ${AUDIT_SELECT_SQL}
      FROM simulation_master
      ORDER BY updated_on DESC NULLS LAST, created_on DESC
    `);

    const formatted = result.rows.map((r) => {
      let decryptedPayload: any = null;
      if (r.encrypted_payload) {
        try {
          decryptedPayload = maybeDecryptPayload(r.encrypted_payload) as any;
        } catch (err) {
          console.warn("Failed to decrypt simulation payload:", err);
        }
      }

      return {
        id: r.id,
        simulationName: decryptedPayload?.simulation_name ?? r.simulation_name,
        context: decryptedPayload?.context ?? r.context,
        form: decryptedPayload?.form ?? r.form,
        inputValues: decryptedPayload?.input_values ?? r.input_values,
        created_by: r.created_by,
        created_on: r.created_on,
        updated_by: r.updated_by,
        updated_on: r.updated_on,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch simulation records" });
  }
});

/**
 * POST /api/simulation
 * Inserts a new simulation record.
 * Body: { simulationName: string, context: string, inputValues: Record<string, string> }
 */
router.post("/", async (req: AuthedRequest, res) => {
  const { simulationName, context, form = "", inputValues } = req.body;

  if (!simulationName || !context) {
    return res
      .status(400)
      .json({ error: "simulationName and context are required" });
  }

  const actor = auditActor(req);

  try {
    const encryptedPayload = buildEncryptedPayload({
      simulation_name: simulationName,
      context,
      form,
      input_values: inputValues ?? {},
      created_by: actor,
      updated_by: actor,
    });

    const result = await pool.query(
      `
      INSERT INTO simulation_master (
        simulation_name, context, form, input_values, encrypted_payload,
        created_by, created_on, updated_by, updated_on
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW(), $6, NOW())
      RETURNING id, simulation_name, context, form, input_values, encrypted_payload, ${AUDIT_SELECT_SQL}
      `,
      [simulationName, context, form, JSON.stringify(inputValues ?? {}), encryptedPayload, actor]
    );

    const r = result.rows[0];
    res.status(201).json({
      id: r.id,
      simulationName: r.simulation_name,
      context: r.context,
      form: r.form,
      inputValues: r.input_values,
      created_by: r.created_by,
      created_on: r.created_on,
      updated_by: r.updated_by,
      updated_on: r.updated_on,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save simulation record" });
  }
});

// Demo API giving the exact screenshot Staples PO payload
router.get('/staples-po', (req, res) => {
  const odataPayload = {
    d: {
      PurchaseOrder: "4501235707",
      OrderDate: "2026-05-04T00:00:00",
      Purchaser: "Inkoop",
      Email: "inkoop@staples.nl",
      PaymentTerms: "Within 30 days without deduction",
      FreightTerms: "DDP",
      Telephone: "+3203237603316",
      Fax: "+3237774798",
      Vendor: {
        Name: "Esselte Business (Belgie)",
        Street: "Industriepark-Noord 29",
        City: "9100 SINT-NIKLAAS",
        Country: "BELGIUM"
      },
      DeliveryAddress: {
        Name: "Staples Logistics Centre",
        Hours: "Mon-Fri 7:00-14:00",
        Street: "Rondebeltweg 102",
        City: "1329 BH ALMERE",
        Country: "NETHERLANDS"
      },
      PurchaseOrderItems: {
        results: [
          {
            Position: "1",
            ArticleNumber: "318733",
            Description: "Brievenbak met lade Leitz Plus A4maxi zw",
            EanCode: "4002432393534 HE",
            VendorArticleNumber: "52100095",
            DeliveryDate: "2026-05-07T00:00:00",
            Quantity: 36,
            UnitOfMeasure: "each",
            Price: 8.51,
            PricePer: "1 each",
            Amount: 306.36,
            GrossPrice: "8.51 / 1 each"
          },
          {
            Position: "2",
            ArticleNumber: "325755",
            Description: "Nieten Leitz P3 24/6 wit/pak 1000",
            EanCode: "4002432399178 HE",
            VendorArticleNumber: "55540000",
            DeliveryDate: "2026-05-07T00:00:00",
            Quantity: 120,
            UnitOfMeasure: "Pack of 1000 Stuks",
            Price: 0.78,
            PricePer: "1 Pack",
            Amount: 93.60,
            GrossPrice: "0.78 / 1 Pack"
          },
          {
            Position: "3",
            ArticleNumber: "347245",
            Description: "Lamineerhoes A4 2x80u gloss Leitz/pk25",
            EanCode: "4002432397631 HE",
            VendorArticleNumber: "74790000",
            DeliveryDate: "2026-05-07T00:00:00",
            Quantity: 10,
            UnitOfMeasure: "Pack of 25 Stuks",
            Price: 3.00,
            PricePer: "1 Pack",
            Amount: 30.00,
            GrossPrice: "3.00 / 1 Pack"
          }
        ]
      }
    }
  };
  res.json(odataPayload);
});

// Demo API giving the CT Lien Solutions nested loop PO data payload
router.get('/nested-invoice', (req, res) => {
  const nestedPayload = {
    d: {
      Invoice: "04365695",
      InvoiceDate: "Jul 22, 2026",
      DueDate: "Aug 21, 2026",
      CustomerNumber: "507266",
      Reference1: "00534-00248",
      BillToName: "Lubin Olson & Niewiadomski LLP",
      BillToStreet: "600 Montgomery Street",
      BillToFloor: "14th Floor",
      BillToCityStateZip: "San Francisco, CA 94111",
      Attention: "JENNIFER DOMINIK",
      OrderNumber: "109927971",
      OrderDate: "07/21/26",
      OrderContact: "JENNIFER DOMINIK",
      groups: [
        {
          name: "B.P.M.P. Family Partners, LLC",
          items: [
            {
              description: "State Lien Search (All available liens) - CA, Secretary of State",
              service_fee: "49.80",
              disbursement: "0.00",
              total: "49.80"
            },
            {
              description: "Federal Tax Lien, State Tax Lien & Judgment Lien Search - CA, Marin County",
              service_fee: "168.00",
              disbursement: "0.00",
              total: "168.00"
            },
            {
              description: "Litigation Search- Searched as Defendant - CA, Marin County Superior Court",
              service_fee: "72.00",
              disbursement: "0.00",
              total: "72.00"
            },
            {
              description: "Federal Litigation Search- Searched as Defendant - CA, U.S. District Court, California Northern District",
              service_fee: "65.40",
              disbursement: "0.00",
              total: "65.40"
            },
            {
              description: "Bankruptcy Search - Searched as Petitioner - CA, U.S. Bankruptcy Court, California Northern District",
              service_fee: "65.40",
              disbursement: "0.00",
              total: "65.40"
            }
          ]
        },
        {
          name: "Bill and Mary Poland 1988 Family Trust",
          items: [
            {
              description: "State Lien Search (All available liens) - CA, Secretary of State",
              service_fee: "49.80",
              disbursement: "0.00",
              total: "49.80"
            },
            {
              description: "Federal Tax Lien, State Tax Lien & Judgment Lien Search - CA, Marin County",
              service_fee: "168.00",
              disbursement: "0.00",
              total: "168.00"
            },
            {
              description: "Litigation Search- Searched as Defendant - CA, Marin County Superior Court",
              service_fee: "72.00",
              disbursement: "0.00",
              total: "72.00"
            },
            {
              description: "Federal Litigation Search- Searched as Defendant - CA, U.S. District Court, California Northern District",
              service_fee: "65.40",
              disbursement: "0.00",
              total: "65.40"
            },
            {
              description: "Bankruptcy Search - Searched as Petitioner - CA, U.S. Bankruptcy Court, California Northern District",
              service_fee: "65.40",
              disbursement: "0.00",
              total: "65.40"
            }
          ]
        },
        {
          name: "Bill R. Poland, Individual and as Trustee of the Bill and Mary Poland 1988 Family Trust",
          items: [
            {
              description: "State Lien Search (All available liens) - CA, Secretary of State",
              service_fee: "49.80",
              disbursement: "0.00",
              total: "49.80"
            },
            {
              description: "Federal Tax Lien, State Tax Lien & Judgment Lien Search - CA, Marin County",
              service_fee: "168.00",
              disbursement: "0.00",
              total: "168.00"
            },
            {
              description: "Litigation Search- Searched as Defendant - CA, Marin County Superior Court",
              service_fee: "72.00",
              disbursement: "0.00",
              total: "72.00"
            },
            {
              description: "Federal Litigation Search- Searched as Defendant - CA, U.S. District Court, California Northern District",
              service_fee: "65.40",
              disbursement: "0.00",
              total: "65.40"
            },
            {
              description: "Bankruptcy Search - Searched as Petitioner - CA, U.S. Bankruptcy Court, California Northern District",
              service_fee: "65.40",
              disbursement: "0.00",
              total: "65.40"
            }
          ]
        },
        {
          name: "BWG PacDev Foundry, LLC",
          items: [
            {
              description: "State Lien Search (All available liens) - CA, Secretary of State",
              service_fee: "49.80",
              disbursement: "0.00",
              total: "49.80"
            },
            {
              description: "Federal Tax Lien, State Tax Lien & Judgment Lien Search - CA, Alameda County",
              service_fee: "168.00",
              disbursement: "0.00",
              total: "168.00"
            },
            {
              description: "Litigation Search- Searched as Defendant - CA, Alameda County Superior Court",
              service_fee: "72.00",
              disbursement: "0.00",
              total: "72.00"
            },
            {
              description: "Federal Litigation Search- Searched as Defendant - CA, U.S. District Court, California Northern District",
              service_fee: "65.40",
              disbursement: "0.00",
              total: "65.40"
            },
            {
              description: "Bankruptcy Search - Searched as Petitioner - CA, U.S. Bankruptcy Court, California Northern District",
              service_fee: "65.40",
              disbursement: "0.00",
              total: "65.40"
            }
          ]
        },
        {
          name: "Mary E. Poland, Individual and as Trustee of the Bill and Mary Poland 1988 Family Trust",
          items: [
            {
              description: "State Lien Search (All available liens) - CA, Secretary of State",
              service_fee: "49.80",
              disbursement: "0.00",
              total: "49.80"
            },
            {
              description: "Federal Tax Lien, State Tax Lien & Judgment Lien Search - CA, Marin County",
              service_fee: "168.00",
              disbursement: "0.00",
              total: "168.00"
            },
            {
              description: "Litigation Search- Searched as Defendant - CA, Marin County Superior Court",
              service_fee: "72.00",
              disbursement: "0.00",
              total: "72.00"
            }
          ]
        }
      ]
    }
  };
  res.json(nestedPayload);
});

// ─── Generic Live-Records List ───────────────────────────────────────────────
// GET /api/simulation/live-records?context=Sales+Order
// Looks up the context by name, authenticates, and returns a list of real
// records from the SAP OData endpoint for use in the simulation dropdown.
router.get('/live-records', async (req, res) => {
  const contextName = String(req.query.context || '').trim();
  if (!contextName) return res.status(400).json({ error: 'context query param required' });

  try {
    const ctxResult = await pool.query(
      `SELECT endpoint, auth_type, auth_url, client_id, client_secret
       FROM contexts WHERE LOWER(name) = LOWER($1) AND status = 'Active' LIMIT 1`,
      [contextName]
    );

    if ((ctxResult.rowCount ?? 0) === 0) {
      return res.json({ records: [], source: 'none' });
    }

    const ctx = ctxResult.rows[0];
    const { endpoint, auth_type, auth_url, client_id, client_secret } = ctx;

    // Only attempt live fetch for OAuth2 contexts with a SAP CAP endpoint
    if (auth_type !== 'OAuth2' || !auth_url || !client_id || !client_secret) {
      return res.json({ records: [], source: 'no-credentials' });
    }

    const axios = (await import('axios')).default;

    // Get token
    const tokenParams = new URLSearchParams();
    tokenParams.append('grant_type', 'client_credentials');
    tokenParams.append('client_id', client_id);
    tokenParams.append('client_secret', client_secret);
    const tokenResp = await axios.post(auth_url, tokenParams.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    const accessToken = tokenResp.data?.access_token;
    if (!accessToken) return res.json({ records: [], source: 'token-failed' });

    const authHeaders = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
    const serviceRoot = endpoint.replace(/\/\$metadata\/?$/i, '').replace(/\/$/, '');

    // ── Sales Order context ────────────────────────────────────────────────────
    if (/sales.?order/i.test(contextName)) {
      const listResp = await axios.get(
        `${serviceRoot}/SalesOrders?$top=20&$select=SalesOrder,SoldToParty,SalesOrderDate,TotalNetAmount,TransactionCurrency,PurchaseOrderByCustomer,SalesOrderType&$format=json`,
        { headers: authHeaders, timeout: 15000 }
      );
      const rows: any[] = listResp.data?.value ?? listResp.data?.d?.results ?? [];
      const records = rows.map((o: any) => ({
        id: o.SalesOrder,
        label: `SO ${o.SalesOrder} — ${o.SoldToParty} — ${o.SalesOrderDate} — ${o.TotalNetAmount} ${o.TransactionCurrency}`,
        meta: {
          SalesOrder: o.SalesOrder,
          SoldToParty: o.SoldToParty,
          SalesOrderDate: o.SalesOrderDate,
          TotalNetAmount: o.TotalNetAmount,
          TransactionCurrency: o.TransactionCurrency,
          PurchaseOrderByCustomer: o.PurchaseOrderByCustomer,
          SalesOrderType: o.SalesOrderType,
        }
      }));
      return res.json({ records, source: 'live-sap', context: contextName, count: records.length });
    }

    // ── Fallback for other OData contexts — try generic entity list ───────────
    return res.json({ records: [], source: 'unsupported-context' });

  } catch (err: any) {
    console.error('[live-records] Error:', err.message);
    return res.json({ records: [], source: 'error', error: err.message });
  }
});

// ─── SAP Sales Order Live Fetch ──────────────────────────────────────────────
// GET /api/simulation/sap-sales-order
// Authenticates via the stored OAuth2 credentials for the "Sales Order" context,
// fetches the first real SAP Sales Order + its items, and returns them in the
// simulation payload shape.  Falls back to a rich demo record if SAP is
// unreachable or no credentials are configured.
router.get('/sap-sales-order', async (req, res) => {
  // Optional ?id= param: fetch a specific Sales Order by its SAP number
  const specificId = req.query.id ? String(req.query.id).trim() : null;

  const DEMO_PAYLOAD = {
    d: {
      SalesOrder: "1",
      SalesOrderType: "OR",
      SalesOrganization: "1000",
      DistributionChannel: "01",
      SoldToParty: "BP-CUST",
      SalesOrderDate: "2024-07-18",
      PurchaseOrderByCustomer: "Test 1",
      TotalNetAmount: "8.00",
      TransactionCurrency: "USD",
      RequestedDeliveryDate: "2024-07-18",
      IncotermsClassification: "EXW",
      IncotermsLocation1: "destination",
      CustomerPaymentTerms: "0003",
      ShippingCondition: "01",
      OverallDeliveryStatus: "C",
      OverallSDProcessStatus: "C",
      SalesOrderItems: {
        results: [
          {
            SalesOrderItem: "10",
            Material: "SUGAR",
            SalesOrderItemText: "Sugar Raw Material",
            RequestedQuantity: "1",
            RequestedQuantityUnit: "LB",
            NetAmount: "8.00",
            TransactionCurrency: "USD",
            MaterialGroup: "01",
            BillingDocumentDate: "2024-07-18",
            ItemGrossWeight: "10",
            ItemNetWeight: "10",
            ItemWeightUnit: "LB",
          }
        ]
      }
    }
  };

  try {
    // 1. Look up the "Sales Order" context from the DB
    const ctxResult = await pool.query(
      "SELECT endpoint, auth_url, client_id, client_secret FROM contexts WHERE name = 'Sales Order' AND status = 'Active' LIMIT 1"
    );

    if (ctxResult.rowCount === 0 || !ctxResult.rows[0].auth_url || !ctxResult.rows[0].client_id || !ctxResult.rows[0].client_secret) {
      console.log('[sap-sales-order] No live credentials found — returning demo payload');
      return res.json(DEMO_PAYLOAD);
    }

    const { endpoint, auth_url, client_id, client_secret } = ctxResult.rows[0];

    // 2. Get OAuth2 token
    const axios = (await import('axios')).default;
    const tokenParams = new URLSearchParams();
    tokenParams.append('grant_type', 'client_credentials');
    tokenParams.append('client_id', client_id);
    tokenParams.append('client_secret', client_secret);

    const tokenResp = await axios.post(auth_url, tokenParams.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });

    const accessToken = tokenResp.data?.access_token;
    if (!accessToken) {
      console.warn('[sap-sales-order] Token response missing access_token — returning demo payload');
      return res.json(DEMO_PAYLOAD);
    }

    const authHeaders = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };

    // 3. Derive service root (strip /$metadata if present)
    const serviceRoot = endpoint.replace(/\/\$metadata\/?$/i, '').replace(/\/$/, '');

    // 4. Fetch Sales Order header — specific by ID if provided, otherwise first
    let header: any;
    let salesOrderId: string;

    if (specificId) {
      // Fetch specific Sales Order by ID
      const soResp = await axios.get(`${serviceRoot}/SalesOrders('${specificId}')?$format=json`, {
        headers: authHeaders, timeout: 12000,
      });
      header = soResp.data;
      salesOrderId = specificId;
    } else {
      const soResp = await axios.get(`${serviceRoot}/SalesOrders?$top=1&$format=json`, {
        headers: authHeaders, timeout: 12000,
      });
      const headerRows: any[] = soResp.data?.value ?? soResp.data?.d?.results ?? [];
      if (headerRows.length === 0) {
        console.warn('[sap-sales-order] No Sales Orders returned — returning demo payload');
        return res.json(DEMO_PAYLOAD);
      }
      header = headerRows[0];
      salesOrderId = header.SalesOrder ?? header.ID ?? header.id;
    }

    // 5. Fetch items for that sales order
    let itemRows: any[] = [];
    try {
      const itemsResp = await axios.get(
        `${serviceRoot}/SalesOrders('${salesOrderId}')/to_Item?$format=json`,
        { headers: authHeaders, timeout: 12000 }
      );
      itemRows = itemsResp.data?.value ?? itemsResp.data?.d?.results ?? [];
    } catch (itemErr: any) {
      console.warn('[sap-sales-order] Items fetch failed:', itemErr.message);
    }

    // 6. Build normalised simulation payload
    const payload = {
      d: {
        SalesOrder: header.SalesOrder ?? '',
        SalesOrderType: header.SalesOrderType ?? '',
        SalesOrganization: header.SalesOrganization ?? '',
        DistributionChannel: header.DistributionChannel ?? '',
        SoldToParty: header.SoldToParty ?? '',
        SalesOrderDate: header.SalesOrderDate ?? '',
        PurchaseOrderByCustomer: header.PurchaseOrderByCustomer ?? '',
        TotalNetAmount: String(header.TotalNetAmount ?? ''),
        TransactionCurrency: header.TransactionCurrency ?? '',
        RequestedDeliveryDate: header.RequestedDeliveryDate ?? '',
        IncotermsClassification: header.IncotermsClassification ?? '',
        IncotermsLocation1: header.IncotermsLocation1 ?? '',
        CustomerPaymentTerms: header.CustomerPaymentTerms ?? '',
        ShippingCondition: header.ShippingCondition ?? '',
        OverallDeliveryStatus: header.OverallDeliveryStatus ?? '',
        OverallSDProcessStatus: header.OverallSDProcessStatus ?? '',
        SalesOrderItems: {
          results: itemRows.map((item: any) => ({
            SalesOrderItem: item.SalesOrderItem ?? '',
            Material: item.Material ?? '',
            SalesOrderItemText: item.SalesOrderItemText ?? '',
            RequestedQuantity: String(item.RequestedQuantity ?? ''),
            RequestedQuantityUnit: item.RequestedQuantityUnit ?? '',
            NetAmount: String(item.NetAmount ?? ''),
            TransactionCurrency: item.TransactionCurrency ?? '',
            MaterialGroup: item.MaterialGroup ?? '',
            BillingDocumentDate: item.BillingDocumentDate ?? '',
            ItemGrossWeight: String(item.ItemGrossWeight ?? ''),
            ItemNetWeight: String(item.ItemNetWeight ?? ''),
            ItemWeightUnit: item.ItemWeightUnit ?? '',
          }))
        }
      }
    };

    console.log(`[sap-sales-order] Live fetch OK — SalesOrder ${salesOrderId}, ${itemRows.length} item(s)`);
    return res.json(payload);

  } catch (err: any) {
    console.error('[sap-sales-order] Live fetch error — returning demo payload:', err.message);
    return res.json(DEMO_PAYLOAD);
  }
});

export default router;
