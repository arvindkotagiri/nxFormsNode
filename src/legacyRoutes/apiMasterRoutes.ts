// @ts-nocheck
import express from 'express';
import { pool } from '../db';
import axios from 'axios';
import https from 'https';
import fs from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import {
  initApiCatalogDb,
  upsertOutputDefinitionRecord,
  syncAllOutputDefinitionsFromContexts,
} from '../db/initApiCatalogDb';

function extractPreviewRows(responseData: any): any[] {
  if (!responseData) return [];
  if (Array.isArray(responseData)) return responseData;
  if (Array.isArray(responseData.value)) return responseData.value;
  if (Array.isArray(responseData.d?.results)) return responseData.d.results;

  if (typeof responseData === 'object') {
    for (const value of Object.values(responseData)) {
      if (Array.isArray(value)) {
        return value;
      }
    }
  }

  return [];
}

const router = express.Router();

// HTTPS Agent for outbound requests. By default we enable strict verification.
// To provide a custom CA bundle set SSL_CA environment variable to a file path.
const httpsAgent = new https.Agent({
  ca: process.env.SSL_CA ? fs.readFileSync(process.env.SSL_CA) : undefined,
  rejectUnauthorized: process.env.REJECT_UNAUTHORIZED !== 'false'
});

router.post('/catalog-init', async (_req, res) => {
  try {
    await initApiCatalogDb();
    res.status(200).json({ status: "success", message: "Contexts and output definition tables initialized" });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

router.get('/catalog', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.*,
        COALESCE(o.output_fields, '[]'::jsonb) AS output_fields
      FROM contexts c
      LEFT JOIN api_output_definitions o ON o.context_id = c.id
      ORDER BY c.created_at DESC
    `);
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
      JSON.stringify(data.fields || {}),
      JSON.stringify(data.entities || []),
      data.username || null,
      data.password || null,
      data.application || null,
      data.environment || null,
      (data.client !== undefined && data.client !== '') ? data.client : null,
    ];

    const result = await pool.query(insertQuery, values);
    const newId = result.rows[0].id;

    await upsertOutputDefinitionRecord(
      newId,
      data.name,
      data.endpoint,
      data.fields || {},
      data.updated_by || data.created_by || 'system',
    );

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
      JSON.stringify(data.fields || {}),
      JSON.stringify(data.entities || []),
      data.username || null,
      data.password || null,
      data.application || null,
      data.environment || null,
      (data.client !== undefined && data.client !== '') ? data.client : null,
      api_id,
    ];

    await pool.query(updateQuery, values);

    await upsertOutputDefinitionRecord(
      Number(api_id),
      data.name,
      data.endpoint,
      data.fields || {},
      data.updated_by || data.created_by || 'system',
    );

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

router.get('/output-definition-fields', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, context_id, name, endpoint, output_fields, created_at, created_by, updated_by, updated_on
      FROM api_output_definitions
      ORDER BY updated_on DESC NULLS LAST, created_at DESC
    `);
    res.status(200).json(result.rows);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/output-definition-fields/sync', async (_req, res) => {
  try {
    await syncAllOutputDefinitionsFromContexts();
    res.status(200).json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/output-definition-fields/active', async (_req, res) => {
  try {
    let result = await pool.query(`
      SELECT id, context_id, name, endpoint, output_fields, created_at, created_by, updated_by, updated_on
      FROM api_output_definitions
      WHERE jsonb_array_length(output_fields) > 0
      ORDER BY name ASC
    `);

    if ((result.rowCount ?? 0) === 0) {
      await syncAllOutputDefinitionsFromContexts();
      result = await pool.query(`
        SELECT id, context_id, name, endpoint, output_fields, created_at, created_by, updated_by, updated_on
        FROM api_output_definitions
        WHERE jsonb_array_length(output_fields) > 0
        ORDER BY name ASC
      `);
    }

    res.status(200).json({ status: 'success', records: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/fetch-metadata', async (req, res) => {
  const data = req.body || {};
  const url = data.url;
  const token_url = data.tokenUrl;
  const client_id = data.clientId;
  const client_secret = data.clientSecret;
  const auth_type = data.authType || 'None';
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

router.post('/preview-data', async (req, res) => {
  const data = req.body || {};
  const url = String(data.url || '').trim();
  const token_url = String(data.tokenUrl || '').trim();
  const client_id = String(data.clientId || '').trim();
  const client_secret = String(data.clientSecret || '').trim();
  const auth_type = String(data.authType || 'None').trim();
  const auth_mode = String(auth_type || '').trim().toLowerCase();
  const username = String(data.username || '').trim();
  const password = String(data.password || '').trim();
  const hasOAuthFields = !!(token_url && client_id && client_secret);
  const hasBasicFields = !!(username && password);
  const isOAuth2 = auth_mode === 'oauth2' || auth_mode === 'oauth 2' || auth_mode === 'oauth 2.0' || auth_mode.includes('oauth') || (auth_mode === 'none' && hasOAuthFields && !hasBasicFields);
  const isBasic = auth_mode === 'basic' || auth_mode === 'basic authentication' || (auth_mode === 'none' && hasBasicFields && !hasOAuthFields);
  const entitySet = String(data.entitySet || '').trim();
  const sampleSize = Number(data.sampleSize) || 5;

  if (!url || !entitySet) {
    return res.status(400).json({ status: 'error', message: 'Base URL and entity set are required' });
  }

  // Preview requests must target the service root, not /$metadata.
  let serviceRootUrl = url;
  let serviceRootSearch = '';
  try {
    const parsed = new URL(url);
    serviceRootUrl = `${parsed.origin}${parsed.pathname}`;
    serviceRootSearch = parsed.search;
  } catch {
    serviceRootUrl = url.split('?')[0];
    serviceRootSearch = url.includes('?') ? `?${url.split('?').slice(1).join('?')}` : '';
  }

  serviceRootUrl = serviceRootUrl.replace(/\/\$metadata\/?$/i, '');
  if (serviceRootUrl.endsWith('/')) {
    serviceRootUrl = serviceRootUrl.slice(0, -1);
  }

  const buildPreviewUrl = (name: string) => {
    const params = new URLSearchParams(serviceRootSearch.startsWith('?') ? serviceRootSearch.slice(1) : serviceRootSearch);
    params.set('$top', String(sampleSize));
    params.set('$format', 'json');
    return `${serviceRootUrl}/${name}?${params.toString()}`;
  };

  const entitySetCandidates = [
    entitySet,
    /Type$/i.test(entitySet) ? entitySet.replace(/Type$/i, '') : null,
  ].filter(Boolean) as string[];

  const previewUrls = Array.from(new Set(entitySetCandidates.map((name) => buildPreviewUrl(name))));

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json'
    };

    if (isOAuth2) {
      const missingOAuthFields = [
        !token_url ? 'tokenUrl' : null,
        !client_id ? 'clientId' : null,
        !client_secret ? 'clientSecret' : null,
      ].filter(Boolean);

      if (missingOAuthFields.length > 0) {
        return res.status(400).json({
          status: 'error',
          message: `OAuth2 requires tokenUrl, clientId, and clientSecret. Missing: ${missingOAuthFields.join(', ')}`,
        });
      }

      const tokenParams = new URLSearchParams();
      tokenParams.append('grant_type', 'client_credentials');
      tokenParams.append('client_id', client_id);
      tokenParams.append('client_secret', client_secret);

      const basicAuth = Buffer.from(`${client_id}:${client_secret}`).toString('base64');
      const authResponse = await axios.post(token_url, tokenParams.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basicAuth}`
        },
        httpsAgent,
        timeout: 10000
      });

      if (authResponse.status !== 200) {
        return res.status(401).json({ status: 'error', message: 'OAuth token request failed' });
      }

      const accessToken = authResponse.data?.access_token;
      if (!accessToken) {
        return res.status(401).json({ status: 'error', message: 'OAuth token response did not include access_token' });
      }
      headers.Authorization = `Bearer ${accessToken}`;
    } else if (isBasic) {
      if (!username || !password) {
        return res.status(400).json({ status: 'error', message: 'Basic auth requires username and password' });
      }
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    let response: any = null;
    let responseRows: any[] = [];
    let lastPreviewError: any = null;
    for (const previewUrl of previewUrls) {
      try {
        response = await axios.get(previewUrl, {
          headers,
          httpsAgent,
          timeout: 10000
        });
        responseRows = extractPreviewRows(response.data);
        const hasMoreCandidates = previewUrl !== previewUrls[previewUrls.length - 1];
        if (responseRows.length === 0 && hasMoreCandidates) {
          continue;
        }
        lastPreviewError = null;
        break;
      } catch (previewErr: any) {
        lastPreviewError = previewErr;
        const status = Number(previewErr?.response?.status) || 0;
        const canTryNext = previewUrl !== previewUrls[previewUrls.length - 1]
          && [401, 403, 404, 405, 501].includes(status);
        if (!canTryNext) {
          throw previewErr;
        }
      }
    }

    if (!response) {
      throw lastPreviewError || new Error('Unable to fetch preview data');
    }

    const responseData = response.data;
    if (!responseData || typeof responseData !== 'object') {
      return res.status(500).json({ status: 'error', message: 'Preview response was not JSON' });
    }

    const rows = responseRows.length > 0 ? responseRows : extractPreviewRows(responseData);

    return res.status(200).json({ status: 'success', rows });
  } catch (err) {
    console.error('Preview data error:', err);
    const upstream = err.response?.data;
    const upstreamText = typeof upstream === 'string' ? upstream : '';
    const isHtmlResponse = upstreamText.trimStart().startsWith('<');
    const upstreamMessage = isHtmlResponse
      ? `Upstream service returned ${Number(err.response?.status) || 500} (${err.response?.statusText || 'Error'}). Check username/password and service authorization.`
      : typeof upstream === 'string'
      ? upstream
      : upstream?.error_description
        || upstream?.error?.message?.value
        || upstream?.error?.message
        || upstream?.error
        || upstream?.message;
    const message = upstreamMessage || err.message || 'Unable to fetch preview data';
    const status = Number(err.response?.status) || 500;
    res.status(status).json({ status: 'error', message });
  }
});

export default router;

