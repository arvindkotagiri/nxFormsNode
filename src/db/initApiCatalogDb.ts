import { pool } from "../db";
import { hashPassword } from "../utils/password";

export function extractOutputFieldsFromCatalog(fieldsData: unknown) {
  const result: Array<{ entity: string; name: string; label: string; type: string | null }> = [];
  if (!fieldsData || typeof fieldsData !== "object") return result;

  for (const [entity, fieldList] of Object.entries(fieldsData as Record<string, unknown>)) {
    const arr = Array.isArray(fieldList) ? fieldList : [];
    for (const field of arr) {
      if (!field || typeof field !== "object") continue;
      const f = field as Record<string, unknown>;
      if (!f.showInOutputDefinition) continue;
      const name = (f.name || f.originalName) as string | undefined;
      if (!name) continue;
      result.push({
        entity,
        name,
        label: (f.label as string) || name,
        type: (f.type as string) || null,
      });
    }
  }

  return result;
}

export async function upsertOutputDefinitionRecord(
  contextId: number,
  name: string,
  endpoint: string,
  fieldsData: unknown,
  actor = "system",
) {
  const outputFields = extractOutputFieldsFromCatalog(fieldsData);
  await pool.query(
    `
    INSERT INTO api_output_definitions (
      context_id, name, endpoint, output_fields, created_by, updated_by, updated_on
    )
    VALUES ($1, $2, $3, $4::jsonb, $5, $5, NOW())
    ON CONFLICT (context_id) DO UPDATE SET
      name = EXCLUDED.name,
      endpoint = EXCLUDED.endpoint,
      output_fields = EXCLUDED.output_fields,
      updated_by = EXCLUDED.updated_by,
      updated_on = NOW()
    `,
    [contextId, name, endpoint, JSON.stringify(outputFields), actor],
  );
}

export async function syncAllOutputDefinitionsFromContexts() {
  const contexts = await pool.query("SELECT id, name, endpoint, fields FROM contexts");
  for (const ctx of contexts.rows) {
    const fields =
      typeof ctx.fields === "string"
          ? JSON.parse(ctx.fields)
          : ctx.fields || {};
    await upsertOutputDefinitionRecord(ctx.id, ctx.name, ctx.endpoint, fields, "system");
  }
}

export async function initApiCatalogDb(): Promise<void> {
  const client = await pool.connect();
  try {
    // 1. Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer',
        password_hash TEXT NOT NULL,
        encrypted_payload TEXT,
        created_by TEXT,
        created_on TIMESTAMPTZ DEFAULT NOW(),
        updated_by TEXT,
        updated_on TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Seed default configurator user if none exist
    const userCheck = await client.query("SELECT 1 FROM users LIMIT 1");
    if (userCheck.rowCount === 0) {
      const passwordHash = await hashPassword("pass1234");
      await client.query(
        `INSERT INTO users (email, name, role, password_hash, created_by, created_on, updated_by, updated_on)
         VALUES ($1, $2, $3, $4, 'system', NOW(), 'system', NOW())`,
        ["configurator@test.com", "Configurator", "configurator", passwordHash]
      );
      console.log("[db] Seeded default configurator user");
    }

    // 2. Create events table
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_number SERIAL,
        source TEXT,
        context TEXT,
        entity_key TEXT,
        event_type TEXT,
        triggered_by TEXT,
        print_to_file TEXT,
        form TEXT,
        payload TEXT,
        status TEXT DEFAULT 'Pending',
        event_timestamp TIMESTAMPTZ DEFAULT NOW(),
        duration_ms INTEGER,
        outputs INTEGER DEFAULT 0,
        error_message TEXT,
        encrypted_payload TEXT,
        created_by TEXT,
        created_on TIMESTAMPTZ DEFAULT NOW(),
        updated_by TEXT,
        updated_on TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 3. Create outputs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS outputs (
        output_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id UUID REFERENCES events(event_id) ON DELETE CASCADE,
        form_id TEXT,
        printer TEXT,
        format TEXT,
        status TEXT DEFAULT 'Pending',
        retries INTEGER DEFAULT 0,
        duration INTEGER,
        error_message TEXT,
        rendered_output TEXT,
        encrypted_payload TEXT,
        output_number SERIAL,
        document_json TEXT,
        completed_at TIMESTAMPTZ,
        created_by TEXT,
        created_on TIMESTAMPTZ DEFAULT NOW(),
        updated_by TEXT,
        updated_on TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 4. Create simulation_master table
    await client.query(`
      CREATE TABLE IF NOT EXISTS simulation_master (
        id SERIAL PRIMARY KEY,
        simulation_name TEXT NOT NULL,
        context TEXT NOT NULL,
        form TEXT,
        input_values JSONB DEFAULT '{}'::jsonb,
        encrypted_payload TEXT,
        created_by TEXT,
        created_on TIMESTAMPTZ DEFAULT NOW(),
        updated_by TEXT,
        updated_on TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 5. Create logs_audit table
    await client.query(`
      CREATE TABLE IF NOT EXISTS logs_audit (
        log_id SERIAL PRIMARY KEY,
        level TEXT NOT NULL,
        service TEXT NOT NULL,
        message TEXT NOT NULL,
        username TEXT,
        trace_id TEXT,
        metadata JSONB,
        event_timestamp TIMESTAMPTZ DEFAULT NOW(),
        created_by TEXT,
        created_on TIMESTAMPTZ DEFAULT NOW(),
        updated_by TEXT,
        updated_on TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS contexts (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        auth_type TEXT,
        auth_url TEXT,
        client_id TEXT,
        client_secret TEXT,
        fields JSONB,
        entities JSONB,
        username TEXT,
        password TEXT,
        status TEXT DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        application TEXT,
        environment TEXT,
        client NUMERIC(3)
      );
    `);

    await client.query(`
      ALTER TABLE contexts
      ADD COLUMN IF NOT EXISTS username TEXT,
      ADD COLUMN IF NOT EXISTS password TEXT,
      ADD COLUMN IF NOT EXISTS application TEXT,
      ADD COLUMN IF NOT EXISTS environment TEXT,
      ADD COLUMN IF NOT EXISTS client NUMERIC(3);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS api_output_definitions (
        id SERIAL PRIMARY KEY,
        context_id INTEGER UNIQUE REFERENCES contexts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        output_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        created_by TEXT,
        updated_by TEXT,
        updated_on TIMESTAMPTZ
      );
    `);

    const labelConfigs = await client.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'label_configs'
      LIMIT 1
    `);
    if ((labelConfigs.rowCount ?? 0) > 0) {
      await client.query(`
        ALTER TABLE label_configs
        ADD COLUMN IF NOT EXISTS output_conditions JSONB DEFAULT '{}'::jsonb
      `);
    }

    await syncAllOutputDefinitionsFromContexts();

    // Seed Staples Purchase Order OData Context if missing
    const staplesEntities = JSON.stringify([
      { name: "PurchaseOrder", label: "PurchaseOrder", isCore: true, enabled: true },
      { name: "PurchaseOrderItems", label: "PurchaseOrderItems", isCore: true, enabled: true }
    ]);
    const staplesFields = JSON.stringify({
      PurchaseOrder: [
        { name: "PurchaseOrder", path: "d.PurchaseOrder" },
        { name: "OrderDate", path: "d.OrderDate" },
        { name: "Purchaser", path: "d.Purchaser" },
        { name: "Email", path: "d.Email" },
        { name: "PaymentTerms", path: "d.PaymentTerms" },
        { name: "FreightTerms", path: "d.FreightTerms" },
        { name: "Telephone", path: "d.Telephone" },
        { name: "Fax", path: "d.Fax" },
        { name: "Vendor_Name", path: "d.Vendor.Name" },
        { name: "Vendor_Street", path: "d.Vendor.Street" },
        { name: "Vendor_City", path: "d.Vendor.City" },
        { name: "Vendor_Country", path: "d.Vendor.Country" }
      ],
      PurchaseOrderItems: [
        { name: "Position", path: "Position" },
        { name: "ArticleNumber", path: "ArticleNumber" },
        { name: "Description", path: "Description" },
        { name: "EanCode", path: "EanCode" },
        { name: "VendorArticleNumber", path: "VendorArticleNumber" },
        { name: "DeliveryDate", path: "DeliveryDate" },
        { name: "Quantity", path: "Quantity" },
        { name: "UnitOfMeasure", path: "UnitOfMeasure" },
        { name: "Price", path: "Price" },
        { name: "PricePer", path: "PricePer" },
        { name: "Amount", path: "Amount" },
        { name: "GrossPrice", path: "GrossPrice" }
      ]
    });

    const checkContext = await client.query("SELECT id FROM contexts WHERE name = 'Staples Purchase Order OData Service' LIMIT 1");
    if ((checkContext.rowCount ?? 0) === 0) {
      await client.query(`
        INSERT INTO contexts (name, endpoint, auth_type, fields, entities, status)
        VALUES ('Staples Purchase Order OData Service', 'http://localhost:4000/api/simulation/staples-po', 'None', $1::jsonb, $2::jsonb, 'Active')
      `, [staplesFields, staplesEntities]);
    } else {
      // Force update context payload and entities structures for existing databases
      await client.query(`
        UPDATE contexts 
        SET fields = $1::jsonb, entities = $2::jsonb 
        WHERE name = 'Staples Purchase Order OData Service'
      `, [staplesFields, staplesEntities]);
    }

    // Seed Staples PO Simulation Context Payload if missing
    const checkSimulation = await client.query("SELECT id FROM simulation_master WHERE simulation_name = 'Staples PO Simulation' LIMIT 1");
    const odataPayloadObj = {
      d: {
        PurchaseOrder: "4501235707",
        OrderDate: "04.05.2026",
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
              DeliveryDate: "07.05.2026",
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
              DeliveryDate: "07.05.2026",
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
              DeliveryDate: "07.05.2026",
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

    if ((checkSimulation.rowCount ?? 0) === 0) {
      await client.query(`
        INSERT INTO simulation_master (simulation_name, context, form, input_values)
        VALUES ('Staples PO Simulation', 'Staples Purchase Order OData Service', '', $1::jsonb)
      `, [JSON.stringify(odataPayloadObj)]);
    } else {
      // Force update existing Staples simulation record fields
      await client.query(`
        UPDATE simulation_master
        SET context = 'Staples Purchase Order OData Service', input_values = $1::jsonb
        WHERE simulation_name = 'Staples PO Simulation'
      `, [JSON.stringify(odataPayloadObj)]);
    }

    // Seed Test Nested Loop API Context & Simulation
    const nestedEntities = JSON.stringify([
      { name: "InvoiceHeader", label: "InvoiceHeader", isCore: true, enabled: true },
      { name: "groups", label: "groups", isCore: true, enabled: true },
      { name: "items", label: "items", isCore: true, enabled: true }
    ]);
    const nestedFields = JSON.stringify({
      InvoiceHeader: [
        { name: "Invoice", path: "d.Invoice" },
        { name: "InvoiceDate", path: "d.InvoiceDate" },
        { name: "DueDate", path: "d.DueDate" },
        { name: "CustomerNumber", path: "d.CustomerNumber" },
        { name: "Reference1", path: "d.Reference1" },
        { name: "BillToName", path: "d.BillToName" },
        { name: "BillToStreet", path: "d.BillToStreet" },
        { name: "BillToFloor", path: "d.BillToFloor" },
        { name: "BillToCityStateZip", path: "d.BillToCityStateZip" },
        { name: "Attention", path: "d.Attention" },
        { name: "OrderNumber", path: "d.OrderNumber" },
        { name: "OrderDate", path: "d.OrderDate" },
        { name: "OrderContact", path: "d.OrderContact" }
      ],
      groups: [
        { name: "name", path: "name" },
        { name: "items", path: "items" }
      ],
      items: [
        { name: "description", path: "description" },
        { name: "service_fee", path: "service_fee" },
        { name: "disbursement", path: "disbursement" },
        { name: "total", path: "total" }
      ]
    });

    const checkNestedContext = await client.query("SELECT id FROM contexts WHERE name = 'Test Nested Loop API' LIMIT 1");
    if ((checkNestedContext.rowCount ?? 0) === 0) {
      await client.query(`
        INSERT INTO contexts (name, endpoint, auth_type, fields, entities, status)
        VALUES ('Test Nested Loop API', 'http://localhost:4000/api/simulation/nested-invoice', 'None', $1::jsonb, $2::jsonb, 'Active')
      `, [nestedFields, nestedEntities]);
    } else {
      await client.query(`
        UPDATE contexts 
        SET fields = $1::jsonb, entities = $2::jsonb 
        WHERE name = 'Test Nested Loop API'
      `, [nestedFields, nestedEntities]);
    }

    const nestedPayloadObj = {
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

    const checkNestedSimulation = await client.query("SELECT id FROM simulation_master WHERE simulation_name = 'Test Nested Loop Simulation' LIMIT 1");
    if ((checkNestedSimulation.rowCount ?? 0) === 0) {
      await client.query(`
        INSERT INTO simulation_master (simulation_name, context, form, input_values)
        VALUES ('Test Nested Loop Simulation', 'Test Nested Loop API', '', $1::jsonb)
      `, [JSON.stringify(nestedPayloadObj)]);
    } else {
      await client.query(`
        UPDATE simulation_master
        SET context = 'Test Nested Loop API', input_values = $1::jsonb
        WHERE simulation_name = 'Test Nested Loop Simulation'
      `, [JSON.stringify(nestedPayloadObj)]);
    }

    console.log("[db] API catalog + output definition tables ready");
  } finally {
    client.release();
  }
}
