import test from "node:test";
import assert from "node:assert/strict";
import { repairJsonString, safeJsonParse } from "../utils/jsonUtils";

test("repairJsonString: strips markdown code fences", () => {
  const input = "```json\n{\"name\": \"John\", \"age\": 30}\n```";
  const repaired = repairJsonString(input);
  assert.equal(repaired, "{\"name\": \"John\", \"age\": 30}");
  assert.deepEqual(JSON.parse(repaired), { name: "John", age: 30 });
});

test("repairJsonString: removes trailing commas before object/array close", () => {
  const input = "{\"items\": [1, 2, 3,], \"status\": \"active\",}";
  const repaired = repairJsonString(input);
  assert.deepEqual(JSON.parse(repaired), { items: [1, 2, 3], status: "active" });
});

test("repairJsonString: closes unclosed quotes, arrays, and object braces", () => {
  const input = "{\"key\": \"value\", \"nested\": [{\"id\": 101";
  const repaired = repairJsonString(input);
  const parsed = JSON.parse(repaired);
  assert.equal(parsed.key, "value");
  assert.equal(parsed.nested[0].id, 101);
});

test("safeJsonParse: handles objects, valid JSON, repaired JSON, and fallbacks", () => {
  // Already object
  assert.deepEqual(safeJsonParse({ a: 1 }), { a: 1 });
  // Null/undefined fallback
  assert.deepEqual(safeJsonParse(null, { fallback: true }), { fallback: true });
  // Valid JSON string
  assert.deepEqual(safeJsonParse('{"ok": true}'), { ok: true });
  // Malformed JSON string with auto-repair
  assert.deepEqual(safeJsonParse('```json\n{"items": ["a", "b",]}'), { items: ["a", "b"] });
});
