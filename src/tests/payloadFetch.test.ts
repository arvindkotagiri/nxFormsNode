import test from "node:test";
import assert from "node:assert/strict";
import { fetchContextPayload } from "../services/payloadFetch";

type MockHttp = {
  get: (url: string, config?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>;
  post: (url: string, body?: unknown, config?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>;
};

function createNoopLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

test("replaces fixed endpoint filter operand so real entity keys resolve", async () => {
  const calls: string[] = [];
  const http: MockHttp = {
    post: async () => ({ status: 200, data: { access_token: "token-123" } }),
    get: async (url: string) => {
      calls.push(url);
      return {
        status: 200,
        data: {
          value: [{ SalesOrder: "203", SalesOrganization: "1010" }],
        },
      };
    },
  };

  const payload = await fetchContextPayload(
    {
      name: "Sales Order V2",
      endpoint:
        "https://example.test/odata/v4/sales-order/SalesOrders?$filter=SalesOrder eq '20'&$expand=to_Item",
      auth_type: "OAuth2",
      auth_url: "https://example.test/oauth/token",
      client_id: "cid",
      client_secret: "secret",
    },
    "203",
    { httpClient: http, logger: createNoopLogger() },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0], /SalesOrder eq '203'/);
  assert.equal(payload.SalesOrder, "203");
  assert.equal((payload.d as Record<string, unknown>).SalesOrganization, "1010");
});

test("normalizes nested OData arrays to legacy results collections", async () => {
  const http: MockHttp = {
    post: async () => ({ status: 200, data: {} }),
    get: async () => ({
      status: 200,
      data: {
        value: [
          {
            SalesOrder: "203",
            to_Item: [
              { SalesOrderItem: "10", Material: "A" },
              { SalesOrderItem: "20", Material: "B" },
            ],
          },
        ],
      },
    }),
  };

  const payload = await fetchContextPayload(
    {
      name: "Any",
      endpoint: "https://example.test/odata/v4/sales-order/SalesOrders?$filter=SalesOrder eq '203'",
      auth_type: "None",
    },
    "203",
    { httpClient: http, logger: createNoopLogger() },
  );

  const d = payload.d as Record<string, unknown>;
  const items = (d.to_Item as Record<string, unknown>).results as unknown[];
  assert.equal(Array.isArray(items), true);
  assert.equal(items.length, 2);
});

test("throws clear error when OData response is empty", async () => {
  const http: MockHttp = {
    post: async () => ({ status: 200, data: {} }),
    get: async () => ({ status: 200, data: { value: [] } }),
  };

  await assert.rejects(
    () =>
      fetchContextPayload(
        {
          name: "Any",
          endpoint: "https://example.test/odata/v4/sales-order/SalesOrders?$filter=SalesOrder eq '203'",
          auth_type: "None",
        },
        "203",
        { httpClient: http, logger: createNoopLogger() },
      ),
    /contained no records/i,
  );
});

test("surfaces upstream API failures with status details", async () => {
  const http: MockHttp = {
    post: async () => ({ status: 200, data: {} }),
    get: async () => {
      const err = new Error("request failed") as Error & {
        response?: { status: number; statusText: string; data: unknown };
      };
      err.response = {
        status: 500,
        statusText: "Internal Server Error",
        data: { message: "backend exploded" },
      };
      throw err;
    },
  };

  await assert.rejects(
    () =>
      fetchContextPayload(
        {
          name: "Any",
          endpoint: "https://example.test/odata/v4/sales-order/SalesOrders?$filter=SalesOrder eq '203'",
          auth_type: "None",
        },
        "203",
        { httpClient: http, logger: createNoopLogger() },
      ),
    /status=500/i,
  );
});

test("fails with clear message when OAuth token retrieval fails", async () => {
  const http: MockHttp = {
    post: async () => {
      const err = new Error("auth failed") as Error & {
        response?: { status: number; statusText: string; data: unknown };
      };
      err.response = {
        status: 401,
        statusText: "Unauthorized",
        data: { error_description: "invalid_client" },
      };
      throw err;
    },
    get: async () => ({ status: 200, data: {} }),
  };

  await assert.rejects(
    () =>
      fetchContextPayload(
        {
          name: "Any",
          endpoint: "https://example.test/odata/v4/sales-order/SalesOrders",
          auth_type: "OAuth2",
          auth_url: "https://example.test/oauth/token",
          client_id: "cid",
          client_secret: "secret",
        },
        "203",
        { httpClient: http, logger: createNoopLogger() },
      ),
    /OAuth token request failed/i,
  );
});

test("handles unexpected but valid schema changes by extracting first collection", async () => {
  const http: MockHttp = {
    post: async () => ({ status: 200, data: {} }),
    get: async () => ({
      status: 200,
      data: {
        records: [
          {
            id: "203",
            items: [{ x: 1 }],
          },
        ],
      },
    }),
  };

  const payload = await fetchContextPayload(
    {
      name: "Any",
      endpoint: "https://example.test/odata/v4/custom/Records",
      auth_type: "None",
      entities: [{ name: "Records" }],
    },
    "203",
    { httpClient: http, logger: createNoopLogger() },
  );

  assert.equal(payload.id, "203");
  const d = payload.d as Record<string, unknown>;
  assert.equal(Array.isArray((d.items as Record<string, unknown>).results), true);
});

test("replaces any get_url placeholder token with entity_key", async () => {
  const calls: string[] = [];
  const http: MockHttp = {
    post: async () => ({ status: 200, data: {} }),
    get: async (url: string) => {
      calls.push(url);
      return {
        status: 200,
        data: {
          value: [{ SalesOrder: "203" }],
        },
      };
    },
  };

  await fetchContextPayload(
    {
      name: "Sales Order V2",
      endpoint: "https://example.test/odata/v4/sales-order",
      get_url: "https://example.test/odata/v4/sales-order/SalesOrders?$filter=SalesOrder eq '{{SalesOrder}}'&$expand=to_Item",
      auth_type: "None",
    },
    "203",
    { httpClient: http, logger: createNoopLogger() },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0], /SalesOrder eq '203'/);
});
