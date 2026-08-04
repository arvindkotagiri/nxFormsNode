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

export default router;
