import { pool } from './db';

const WORKING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Sales Order Invoice V2</title>
    <style>
        @page {
            size: A4 portrait;
            margin: 15mm;
        }
        body {
            font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
            color: #000000;
            margin: 0;
            padding: 0;
            background-color: #ffffff;
            font-size: 11px;
            line-height: 1.4;
        }
        .page {
            width: 100%;
            max-width: 800px;
            margin: 0 auto;
            background: #fff;
            box-sizing: border-box;
        }
        .header-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 25px;
        }
        .header-table td {
            vertical-align: top;
        }
        .title-banner {
            text-align: center;
            font-size: 16px;
            font-weight: 800;
            letter-spacing: 0.5px;
            padding: 10px 0;
            text-transform: uppercase;
        }
        .meta-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
        }
        .meta-table td {
            padding: 2px 0;
        }
        .meta-label {
            text-align: right;
            padding-right: 8px !important;
            color: #333;
        }
        .meta-val {
            text-align: right;
            font-weight: bold;
        }
        .address-block {
            font-size: 11px;
            line-height: 1.4;
            color: #000;
        }
        .address-block strong {
            font-size: 12px;
        }
        .main-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
            page-break-inside: auto;
        }
        .main-table th {
            background-color: #000000;
            color: #ffffff;
            padding: 6px 10px;
            font-size: 11px;
            font-weight: bold;
            text-align: left;
        }
        .group-name-row td {
            padding: 14px 0 6px 0;
            font-weight: bold;
            font-size: 12px;
            color: #000;
        }
        .item-row td {
            padding: 4px 10px 4px 14px;
            font-size: 11px;
            vertical-align: top;
            color: #000;
        }
        .subtotal-row td {
            padding: 10px 10px 10px 0;
            font-size: 11px;
            font-weight: bold;
            text-align: right;
            border-top: 1px solid #000;
            border-bottom: 1.5px solid #000;
        }
        .footer-note {
            margin-top: 40px;
            padding-top: 10px;
            border-top: 1px solid #ccc;
            font-size: 9px;
            color: #555;
            display: flex;
            justify-content: space-between;
        }
    </style>
</head>
<body>
<div class="page" data-editor-container="true">
    <!-- TOP BRANDING & HEADER -->
    <table class="header-table">
        <tr>
            <td style="width: 35%;">
                <div style="font-weight: bold; font-size: 16px; color: #000;">CT Lien Solutions</div>
                <div style="font-size: 9px; color: #666; font-style: italic;">a Wolters Kluwer business</div>
            </td>
            <td style="width: 30%; vertical-align: middle;">
                <div class="title-banner">ON DEMAND INVOICE</div>
            </td>
            <td style="width: 35%;">
                <table class="meta-table">
                    <tr><td class="meta-label">Page:</td><td class="meta-val">1</td></tr>
                    <tr><td class="meta-label">Invoice #:</td><td class="meta-val" data-sap-mapping="invoiceNumber">{{#if invoiceNumber}}{{invoiceNumber}}{{else}}04365695{{/if}}</td></tr>
                    <tr><td class="meta-label">Invoice Date:</td><td class="meta-val" data-sap-mapping="invoiceDate">{{#if invoiceDate}}{{invoiceDate}}{{else}}Jul 22, 2026{{/if}}</td></tr>
                    <tr><td class="meta-label">Due Date:</td><td class="meta-val" data-sap-mapping="dueDate">{{#if dueDate}}{{dueDate}}{{else}}Aug 21, 2026{{/if}}</td></tr>
                    <tr><td class="meta-label">Customer #:</td><td class="meta-val" data-sap-mapping="customerNumber">{{#if customerNumber}}{{customerNumber}}{{else}}507266{{/if}}</td></tr>
                    <tr><td class="meta-label">Reference 1:</td><td class="meta-val" data-sap-mapping="reference1">{{#if reference1}}{{reference1}}{{else}}00534-00248{{/if}}</td></tr>
                </table>
            </td>
        </tr>
    </table>

    <!-- BILLING ADDRESS BLOCK -->
    <div style="margin-bottom: 20px;" class="address-block">
        <strong data-sap-mapping="clientName">{{#if clientName}}{{clientName}}{{else}}Lubin Olson &amp; Niewiadomski LLP{{/if}}</strong><br>
        600 Montgomery Street<br>
        14th Floor<br>
        San Francisco, CA 94111<br>
        Attention: <span data-sap-mapping="attentionName">{{#if attentionName}}{{attentionName}}{{else}}JENNIFER DOMINIK{{/if}}</span>
    </div>

    <!-- MULTI-TABLE PER ORDERING CONTACT -->
    {{#if contactTables}}
        {{#each contactTables}}
        <table class="main-table" data-table-config="{&quot;entitySetKey&quot;:&quot;contactTables&quot;,&quot;innerEntitySetKey&quot;:&quot;endUserGroups&quot;,&quot;sortCriteria&quot;:[],&quot;alreadySorted&quot;:true,&quot;filters&quot;:[],&quot;subtotalFields&quot;:[]}">
          <thead>
            <tr>
              <th style="width: 56%;">Order# {{orderNumber}} {{orderDate}} {{orderingContact}}</th>
              <th style="width: 15%; text-align: right;">Service Fee</th>
              <th style="width: 15%; text-align: right;">Disbursement</th>
              <th style="width: 14%; text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            {{#each endUserGroups}}
              <!-- End User Section Header -->
              <tr class="group-name-row">
                <td colspan="4" data-sap-mapping="endUser">{{#if endUser}}{{endUser}}{{else}}{{name}}{{/if}}</td>
              </tr>

              <!-- Line Items under End User -->
              {{#each this.items}}
                <tr class="item-row">
                  <td data-sap-mapping="item.description">{{description}}</td>
                  <td style="text-align: right;" data-sap-mapping="item.service_fee">{{#if service_fee}}{{service_fee}}{{else if serviceFee}}{{serviceFee}}{{else}}$0.00{{/if}}</td>
                  <td style="text-align: right;" data-sap-mapping="item.disbursement">{{#if disbursement}}{{disbursement}}{{else}}$0.00{{/if}}</td>
                  <td style="text-align: right;" data-sap-mapping="item.total">{{#if total}}{{total}}{{else}}$0.00{{/if}}</td>
                </tr>
              {{/each}}

              <!-- Subtotal Row per End User -->
              <tr class="subtotal-row">
                <td style="text-align: right;">Target Sub Total:</td>
                <td style="text-align: right;">{{#if subtotal_service_fee}}{{subtotal_service_fee}}{{else if subtotalServiceFee}}{{subtotalServiceFee}}{{else}}$0.00{{/if}}</td>
                <td style="text-align: right;">{{#if subtotal_disbursement}}{{subtotal_disbursement}}{{else if subtotalDisbursement}}{{subtotalDisbursement}}{{else}}$0.00{{/if}}</td>
                <td style="text-align: right;">{{#if subtotal_total}}{{subtotal_total}}{{else if subtotalTotal}}{{subtotalTotal}}{{else}}$0.00{{/if}}</td>
              </tr>
            {{/each}}
          </tbody>
        </table>
        {{/each}}
    {{else if groups}}
        {{#each groups}}
        <table class="main-table">
          <thead>
            <tr>
              <th style="width: 56%;">Order# {{../OrderNumber}} {{../OrderDate}} {{../Attention}}</th>
              <th style="width: 15%; text-align: right;">Service Fee</th>
              <th style="width: 15%; text-align: right;">Disbursement</th>
              <th style="width: 14%; text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr class="group-name-row">
              <td colspan="4">{{name}}</td>
            </tr>
            {{#each items}}
              <tr class="item-row">
                <td>{{description}}</td>
                <td style="text-align: right;">\${{service_fee}}</td>
                <td style="text-align: right;">\${{disbursement}}</td>
                <td style="text-align: right;">\${{total}}</td>
              </tr>
            {{/each}}
          </tbody>
        </table>
        {{/each}}
    {{/if}}

    <div class="footer-note">
        <div>Checks payable to: CT Lien Solutions<br>P.O. Box 301133, Dallas, TX 75303-1133 USA</div>
        <div>Email Invoice Inquiries To: LienSolutions.ClientSupport@wolterskluwer.com<br>Phone: 800-833-5778</div>
    </div>
</div>
</body>
</html>`;

export async function restoreSalesOrderV2Templates() {
  try {
    const res = await pool.query(
      "UPDATE label_master SET html_code = $1 WHERE label_name ILIKE '%Sales Order%' OR label_name ILIKE '%V2%' OR label_name ILIKE '%Testing%' RETURNING uuid, label_name",
      [WORKING_HTML]
    );
    console.log(`[restoreSalesOrderV2Templates] Updated ${res.rowCount} templates in label_master:`);
    res.rows.forEach(r => console.log(`- [${r.uuid}] ${r.label_name}`));
    return res.rowCount;
  } catch (err) {
    console.error("[restoreSalesOrderV2Templates] DB Error:", err);
    throw err;
  }
}

// Auto execute if run directly via node / npx ts-node
if (require.main === module) {
  restoreSalesOrderV2Templates().then(() => pool.end());
}
