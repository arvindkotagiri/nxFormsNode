require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const labelId = 'LBL-PCBN627SQ';
  const q = await c.query('SELECT html_code FROM label_master WHERE label_id = $1 ORDER BY version DESC LIMIT 1', [labelId]);
  const html = String(q.rows[0]?.html_code || '');
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  const tokens = new Set();
  let m;
  while ((m = re.exec(html)) !== null) tokens.add(String(m[1]).trim());
  console.log(JSON.stringify({ tokenCount: tokens.size, tokens: Array.from(tokens).sort() }, null, 2));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
