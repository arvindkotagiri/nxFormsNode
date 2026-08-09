/**
 * Robust JSON cleaning and parsing utility for LLM responses.
 * Handles Markdown code fences, raw control characters, trailing commas,
 * leading/trailing conversational text, and truncated structures.
 */

export function repairJsonString(jsonStr: string): string {
  if (!jsonStr) return "";
  let str = jsonStr.trim();

  // 1. Remove markdown code fences if present
  if (str.includes("```")) {
    str = str
      .replace(/^```(?:json)?\s*/gi, "")
      .replace(/```$/g, "")
      .trim();
  }

  // 2. Extract potential JSON payload (from first { or [ to last } or ])
  const firstCurly = str.indexOf("{");
  const firstSquare = str.indexOf("[");
  let startIndex = -1;
  let endIndex = -1;

  if (firstCurly !== -1 && (firstSquare === -1 || firstCurly < firstSquare)) {
    startIndex = firstCurly;
    endIndex = str.lastIndexOf("}");
  } else if (firstSquare !== -1) {
    startIndex = firstSquare;
    endIndex = str.lastIndexOf("]");
  }

  if (startIndex !== -1 && endIndex > startIndex) {
    str = str.substring(startIndex, endIndex + 1);
  }

  // 3. Remove trailing commas before brackets/braces
  str = str.replace(/,\s*([\]}])/g, "$1");

  // 4. Try quick parse
  try {
    JSON.parse(str);
    return str;
  } catch {
    // Continue to character stack repair below
  }

  // 5. Advanced Character Stack Repair for unclosed quotes/brackets/braces
  let result = "";
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      } else if (char === "\n") {
        // Escape raw unescaped newlines inside strings
        result += "\\n";
        continue;
      } else if (char === "\r") {
        // Omit carriage returns inside strings
        continue;
      } else if (char === "\t") {
        result += "\\t";
        continue;
      }
      result += char;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      result += char;
    } else if (char === "}") {
      if (stack[stack.length - 1] === "{") {
        stack.pop();
        result += char;
      }
    } else if (char === "]") {
      if (stack[stack.length - 1] === "[") {
        stack.pop();
        result += char;
      }
    } else {
      result += char;
    }
  }

  if (inString) {
    result += '"';
  }

  while (stack.length > 0) {
    const openChar = stack.pop();
    if (openChar === "{") {
      result += "}";
    } else if (openChar === "[") {
      result += "]";
    }
  }

  return result;
}

export function safeJsonParse<T = any>(rawInput: any, fallback: T = [] as any): T {
  if (rawInput === null || rawInput === undefined) return fallback;
  if (typeof rawInput === "object") return rawInput as T;

  const str = String(rawInput).trim();
  if (!str) return fallback;

  // Attempt 1: Direct JSON.parse
  try {
    return JSON.parse(str);
  } catch {
    // Attempt 2: Repaired string parse
    try {
      const repaired = repairJsonString(str);
      return JSON.parse(repaired);
    } catch (err: any) {
      console.warn(`[safeJsonParse] Unable to parse raw LLM JSON response. String snippet: "${str.substring(0, 100)}..." Error: ${err.message}`);
      return fallback;
    }
  }
}
