// @ts-nocheck
import express from 'express';
import { pool } from '../db';
import axios from 'axios';
import https from 'https';
import fs from 'fs';
import { DOMParser } from '@xmldom/xmldom';

const router = express.Router();

// HTTPS Agent for outbound requests. By default we enable strict verification.
// To provide a custom CA bundle set SSL_CA environment variable to a file path.
const httpsAgent = new https.Agent({
  ca: process.env.SSL_CA ? fs.readFileSync(process.env.SSL_CA) : undefined,
  rejectUnauthorized: process.env.REJECT_UNAUTHORIZED !== 'false'
});

router.post('/catalog-init', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
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
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`
        ALTER TABLE contexts 
        ADD COLUMN IF NOT EXISTS username TEXT,
        ADD COLUMN IF NOT EXISTS password TEXT;
      `);

      await client.query(`
        ALTER TABLE contexts
        ADD COLUMN IF NOT EXISTS application TEXT,
        ADD COLUMN IF NOT EXISTS environment TEXT,
        ADD COLUMN IF NOT EXISTS client NUMERIC(3);
      `);

      res.status(200).json({ status: "success", message: "Contexts table initialized" });
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

router.get('/catalog', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM contexts ORDER BY created_at DESC");
    res.status(200).json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/catalog', async (req, res) => {
  try {
    const data = req.body || {};
    const insertQuery = `
      INSERT INTO contexts (
        name, endpoint, auth_type, auth_url, client_id, client_secret, 
        fields, entities, username, password, application, environment, client
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id;
    `;

    const values = [
      data.name,
      data.endpoint,
      data.auth_type || null,
      data.auth_url || null,
      data.client_id || null,
      data.client_secret || null,
      JSON.stringify(data.fields || []),
      JSON.stringify(data.entities || []),
      data.username || null,
      data.password || null,
      data.application || null,
      data.environment || null,
      data.client !== undefined ? data.client : null
    ];

    const result = await pool.query(insertQuery, values);
    const newId = result.rows[0].id;
    res.status(200).json({ status: "success", id: newId });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

router.put('/catalog/:api_id', async (req, res) => {
  const { api_id } = req.params;
  try {
    const data = req.body || {};
    const updateQuery = `
      UPDATE contexts 
      SET 
        name = $1, endpoint = $2, auth_type = $3, auth_url = $4, client_id = $5, client_secret = $6, 
        fields = $7, entities = $8, username = $9, password = $10, application = $11, environment = $12, client = $13
      WHERE id = $14
    `;

    const values = [
      data.name,
      data.endpoint,
      data.auth_type || null,
      data.auth_url || null,
      data.client_id || null,
      data.client_secret || null,
      JSON.stringify(data.fields || []),
      JSON.stringify(data.entities || []),
      data.username || null,
      data.password || null,
      data.application || null,
      data.environment || null,
      data.client !== undefined ? data.client : null,
      api_id
    ];

    await pool.query(updateQuery, values);
    res.status(200).json({ status: "success" });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

router.delete('/catalog/:api_id', async (req, res) => {
  const { api_id } = req.params;
  try {
    await pool.query("DELETE FROM contexts WHERE id = $1", [api_id]);
    res.status(200).json({ status: "success" });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

router.post('/fetch-metadata', async (req, res) => {
  const data = req.body || {};
  const url = data.url;
  const token_url = data.tokenUrl;
  const client_id = data.clientId;
  const client_secret = data.clientSecret;
  const auth_type = data.authType || 'OAuth2';
  const username = data.username;
  const password = data.password;

  if (!url) {
    return res.status(400).json({ status: "error", message: "URL is required" });
  }

  // Append $metadata if not present
  let metadataUrl = url;
  if (!metadataUrl.endsWith('$metadata')) {
    metadataUrl = metadataUrl.endsWith('/') ? metadataUrl + '$metadata' : metadataUrl + '/$metadata';
  }

  try {
    const headers = {};
    let authOptions = null;

    // Fetch OAuth token if auth details are provided
    if (auth_type === 'OAuth2' && token_url && client_id && client_secret) {
      console.log(`[FETCH_METADATA] Requesting token from ${token_url}`);
      try {
        const tokenParams = new URLSearchParams();
        tokenParams.append('grant_type', 'client_credentials');
        tokenParams.append('client_id', client_id);
        tokenParams.append('client_secret', client_secret);

        const basicAuth = Buffer.from(`${client_id}:${client_secret}`).toString('base64');

        const authResponse = await axios.post(token_url, tokenParams.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${basicAuth}`
          },
          httpsAgent,
          timeout: 10000
        });

        if (authResponse.status !== 200) {
          console.error(`[FETCH_METADATA] Auth Failed. Status code: ${authResponse.status}`);
          return res.status(401).json({
            status: "error",
            message: `OAuth Authentication failed (Status ${authResponse.status})`
          });
        }

        const tokenData = authResponse.data || {};
        const accessToken = tokenData.access_token;
        if (accessToken) {
          console.log(`[FETCH_METADATA] Got token successfully! Length: ${accessToken.length}`);
          headers['Authorization'] = `Bearer ${accessToken}`;
        }
      } catch (authErr) {
        console.error("[FETCH_METADATA] OAuth exception:", authErr.message);
        return res.status(401).json({
          status: "error",
          message: `OAuth Authentication exception: ${authErr.message}`
        });
      }
    } else if (auth_type === 'Basic' && username && password) {
      console.log(`[FETCH_METADATA] Using Basic Auth for ${username}`);
      const basicAuth = Buffer.from(`${username}:${password}`).toString('base64');
      headers['Authorization'] = `Basic ${basicAuth}`;
    }

    console.log(`[FETCH_METADATA] Requesting OData metadata from ${metadataUrl}`);
    
    let response;
    try {
      response = await axios.get(metadataUrl, {
        headers,
        httpsAgent,
        timeout: 10000
      });
    } catch (reqErr) {
      const status = reqErr.response ? reqErr.response.status : 500;
      console.error(`[FETCH_METADATA] Request Failed. Status: ${status}`);

      if (status === 404) {
        // Test base URL
        try {
          const baseCheck = await axios.get(url, { headers, httpsAgent, timeout: 5000 });
          if (baseCheck.status === 200) {
            return res.status(404).json({
              status: "error",
              message: "Connected successfully via Token, but $metadata endpoint is missing (404) at the provided Service Endpoint. Please check if your CAP service exposes $metadata. Base URL returned: 200 OK."
            });
          }
        } catch (baseErr) {
          const baseStatus = baseErr.response ? baseErr.response.status : 500;
          if (baseStatus === 401) {
            return res.status(401).json({
              status: "error",
              message: "Connected, but token was rejected by the service (401 Unauthorized). Please check your credentials and token scopes."
            });
          }
        }
        return res.status(404).json({
          status: "error",
          message: "Service Endpoint returned error and $metadata returned 404. Ensure you provided the exact valid OData V4 Service Endpoint."
        });
      }
      return res.status(status).json({
        status: "error",
        message: `Failed to fetch metadata (Status ${status}): ${reqErr.message}`
      });
    }

    console.log(`[FETCH_METADATA] Metadata Response Status: ${response.status}`);

    const xmlText = response.data;
    if (typeof xmlText !== 'string' && !(xmlText instanceof Buffer)) {
      throw new Error("Metadata response was not text");
    }

    const xmlString = xmlText.toString();
    const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
    const entities = [];

    // Namespace-agnostic element selection: we check localName or getElementsByTagNameNS if needed, 
    // but xmldom's getElementsByTagName works on tag name directly if we don't bind namespaces,
    // or we can iterate over all elements.
    const allEntityTypes = doc.getElementsByTagNameNS('*', 'EntityType');
    const entityTypesList = allEntityTypes.length > 0 ? allEntityTypes : doc.getElementsByTagName('EntityType');

    for (let i = 0; i < entityTypesList.length; i++) {
      const entityType = entityTypesList[i];
      const name = entityType.getAttribute('Name');
      const fields = [];

      // Find Key PropertyRef names
      const keyNames = new Set();
      const propertyRefs = entityType.getElementsByTagNameNS ? entityType.getElementsByTagNameNS('*', 'PropertyRef') : entityType.getElementsByTagName('PropertyRef');
      for (let j = 0; j < propertyRefs.length; j++) {
        keyNames.add(propertyRefs[j].getAttribute('Name'));
      }

      // Find properties directly under this entity type
      const childNodes = entityType.childNodes;
      for (let j = 0; j < childNodes.length; j++) {
        const node = childNodes[j];
        if (node.nodeType === 1 && (node.localName === 'Property' || node.tagName === 'Property' || node.tagName?.endsWith(':Property'))) {
          const propName = node.getAttribute('Name');
          
          // Get sap:label or sap label attribute if it exists
          let label = propName;
          for (let k = 0; k < node.attributes.length; k++) {
            const attr = node.attributes[k];
            if (attr.localName === 'label' || attr.name === 'sap:label') {
              label = attr.value;
              break;
            }
          }

          fields.push({
            name: propName,
            type: node.getAttribute('Type'),
            label: label,
            isKey: keyNames.has(propName)
          });
        }
      }

      // Find direct child navigation properties
      const navProps = [];
      for (let j = 0; j < childNodes.length; j++) {
        const node = childNodes[j];
        if (node.nodeType === 1 && (node.localName === 'NavigationProperty' || node.tagName === 'NavigationProperty' || node.tagName?.endsWith(':NavigationProperty'))) {
          navProps.push({
            name: node.getAttribute('Name'),
            relationship: node.getAttribute('Relationship') || null,
            to: node.getAttribute('ToRole') || node.getAttribute('Name')
          });
        }
      }

      entities.push({
        name,
        fields,
        navigation: navProps
      });
    }

    res.status(200).json({ status: "success", entities });
  } catch (err) {
    console.error("Error fetching metadata:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;

