// const n2words: any = require("n2words");
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { evaluate } from "mathjs";

dayjs.extend(utc);
dayjs.extend(customParseFormat);

type SourceData = Record<string, any>;

//////////////////////////
// String Functions
//////////////////////////

export const DIRECT_COPY = (source: SourceData, source_field: string) => {
  return source[source_field];
};

export const TRIM = (source: SourceData, source_field: string) => {
  const value = source[source_field];
  return typeof value === "string" ? value.trim() : value;
};

export const UPPER = (source: SourceData, source_field: string) => {
  const value = source[source_field];
  return typeof value === "string" ? value.toUpperCase() : value;
};

export const LOWER = (source: SourceData, source_field: string) => {
  const value = source[source_field];
  return typeof value === "string" ? value.toLowerCase() : value;
};

export const TRUNCATE = (
  source: SourceData,
  source_field: string,
  max_length: number,
  suffix = ""
) => {
  const value = source[source_field];
  if (typeof value !== "string") return value;
  if (value.length <= max_length) return value;
  return value.slice(0, max_length) + suffix;
};

export const CONCAT = (
  source: SourceData,
  fields: string[],
  separator = ""
) => {
  return fields.map((f) => source[f] ?? "").join(separator);
};

export const DEFAULT_VALUE = (
  source: SourceData,
  source_field: string,
  default_val: any
) => {
  const value = source[source_field];
  return value == null || value === "" ? default_val : value;
};

export const REPLACE = (
  source: SourceData,
  source_field: string,
  find: string | RegExp,
  replacement: string
) => {
  const value = source[source_field];
  if (typeof value !== "string") return value;
  return value.replace(find, replacement);
};

export const REGEX_EXTRACT = (
  source: SourceData,
  source_field: string,
  pattern: string | RegExp,
  group = 0
) => {
  const value = source[source_field];
  if (typeof value !== "string") return value;
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const match = value.match(regex);
  return match ? match[group] : null;
};

//////////////////////////
// Conditional Functions
//////////////////////////

export const IF_ELSE = (
  source: SourceData,
  condition: (src: SourceData) => boolean,
  then_expr: (src: SourceData) => any,
  else_expr: (src: SourceData) => any
) => {
  return condition(source) ? then_expr(source) : else_expr(source);
};

export const SWITCH_CASE = (
  source: SourceData,
  switch_field: string,
  cases: { when: any; then: any }[],
  default_val: any
) => {
  const value = source[switch_field];
  const match = cases.find((c) => c.when === value);
  return match ? match.then : default_val;
};

export const COALESCE = (source: SourceData, fields: string[]) => {
  for (const f of fields) {
    const value = source[f];
    if (value != null && value !== "") return value;
  }
  return null;
};

export const NULL_CHECK = (
  source: SourceData,
  source_field: string,
  not_null_expr: (src: SourceData) => any,
  null_expr: (src: SourceData) => any
) => {
  const value = source[source_field];
  return value != null && value !== "" ? not_null_expr(source) : null_expr(source);
};

//////////////////////////
// Math Functions
//////////////////////////

export const ADD = (source: SourceData, source_field: string, operand: number | string) => {
  const val1 = source[source_field];
  const val2 = typeof operand === "string" ? source[operand] : operand;
  return (val1 ?? 0) + (val2 ?? 0);
};

export const SUBTRACT = (source: SourceData, source_field: string, operand: number | string) => {
  const val1 = source[source_field];
  const val2 = typeof operand === "string" ? source[operand] : operand;
  return (val1 ?? 0) - (val2 ?? 0);
};

export const MULTIPLY = (source: SourceData, source_field: string, operand: number | string) => {
  const val1 = source[source_field];
  const val2 = typeof operand === "string" ? source[operand] : operand;
  return (val1 ?? 0) * (val2 ?? 0);
};

export const DIVIDE = (source: SourceData, source_field: string, operand: number | string) => {
  const val1 = source[source_field];
  const val2 = typeof operand === "string" ? source[operand] : operand;
  if (!val2) return null; // avoid division by zero
  return (val1 ?? 0) / val2;
};

export const ROUND = (source: SourceData, source_field: string, decimal_places = 0) => {
  const val = source[source_field];
  if (typeof val !== "number") return val;
  const factor = Math.pow(10, decimal_places);
  return Math.round(val * factor) / factor;
};

export const EXPRESSION = (source: SourceData, expression_string: string) => {
  try {
    return evaluate(expression_string, source);
  } catch {
    return null;
  }
};

//////////////////////////
// Scaled Rounding Functions
//////////////////////////

export const ROUND_TO_THOUSANDS = (
  source: SourceData,
  source_field: string,
  decimal_places = 1,
  suffix = "K"
) => {
  const val = source[source_field];
  if (typeof val !== "number") return val;

  const scaled = val / 1000;
  const factor = Math.pow(10, decimal_places);
  const rounded = Math.round(scaled * factor) / factor;

  return suffix ? `${rounded}${suffix}` : rounded;
};

export const ROUND_TO_MILLIONS = (
  source: SourceData,
  source_field: string,
  decimal_places = 2,
  suffix = "M"
) => {
  const val = source[source_field];
  if (typeof val !== "number") return val;

  const scaled = val / 1_000_000;
  const factor = Math.pow(10, decimal_places);
  const rounded = Math.round(scaled * factor) / factor;

  return suffix ? `${rounded}${suffix}` : rounded;
};

export const ROUND_TO_BILLIONS = (
  source: SourceData,
  source_field: string,
  decimal_places = 2,
  suffix = "B"
) => {
  const val = source[source_field];
  if (typeof val !== "number") return val;

  const scaled = val / 1_000_000_000;
  const factor = Math.pow(10, decimal_places);
  const rounded = Math.round(scaled * factor) / factor;

  return suffix ? `${rounded}${suffix}` : rounded;
};

export const ROUND_TO_SCALE = (
  source: SourceData,
  source_field: string,
  scale: number,
  decimal_places = 0,
  suffix = ""
) => {
  const val = source[source_field];
  if (typeof val !== "number" || !scale) return val;

  const scaled = Math.round(val / scale) * scale;

  const factor = Math.pow(10, decimal_places);
  const rounded = Math.round(scaled * factor) / factor;

  return suffix ? `${rounded}${suffix}` : rounded;
};

//////////////////////////
// Locale Helpers
//////////////////////////

const normalizeLocale = (locale: string) => {
  if (!locale) return "en-US";
  return locale.replace("_", "-");
};

//////////////////////////
// Locale Formatting Functions
//////////////////////////

export const FORMAT_NUMBER = (
  source: SourceData,
  source_field: string,
  locale: string,
  decimal_places = 2
) => {
  const val = source[source_field];
  if (typeof val !== "number") return val;

  return new Intl.NumberFormat(normalizeLocale(locale), {
    minimumFractionDigits: decimal_places,
    maximumFractionDigits: decimal_places
  }).format(val);
};

export const FORMAT_CURRENCY = (
  source: SourceData,
  source_field: string,
  locale: string,
  currency_code: string
) => {
  const val = source[source_field];
  if (typeof val !== "number") return val;

  return new Intl.NumberFormat(normalizeLocale(locale), {
    style: "currency",
    currency: currency_code
  }).format(val);
};

export const FORMAT_PERCENT = (
  source: SourceData,
  source_field: string,
  locale: string,
  decimal_places = 1
) => {
  const val = source[source_field];
  if (typeof val !== "number") return val;

  return new Intl.NumberFormat(normalizeLocale(locale), {
    style: "percent",
    minimumFractionDigits: decimal_places,
    maximumFractionDigits: decimal_places
  }).format(val / 100);
};

export const FORMAT_COMPACT = (
  source: SourceData,
  source_field: string,
  locale: string,
  decimal_places = 1
) => {
  const val = source[source_field];
  if (typeof val !== "number") return val;

  return new Intl.NumberFormat(normalizeLocale(locale), {
    notation: "compact",
    minimumFractionDigits: decimal_places,
    maximumFractionDigits: decimal_places
  }).format(val);
};

export const FORMAT_SCIENTIFIC = (
  source: SourceData,
  source_field: string,
  locale: string,
  significant_digits = 4
) => {
  const val = source[source_field];
  if (typeof val !== "number") return val;

  return new Intl.NumberFormat(normalizeLocale(locale), {
    notation: "scientific",
    maximumSignificantDigits: significant_digits
  }).format(val);
};

//////////////////////////
// Number to Words
//////////////////////////

// export const NUM_TO_WORDS = (
//   source: SourceData,
//   source_field: string,
//   lang = "en",
//   ordinal = false,
//   currency = false,
//   currency_code = "USD"
// ) => {
//   const val = source[source_field];

//   if (typeof val !== "number") return val;

//   try {
//     if (currency) {
//       // n2words currency support
//       return n2words(val, {
//         lang,
//         currency: currency_code
//       });
//     }

//     if (ordinal) {
//       return n2words(val, {
//         lang,
//         ordinal: true
//       });
//     }

//     return n2words(val, { lang });
//   } catch (err) {
//     console.error("NUM_TO_WORDS error:", err);
//     return String(val);
//   }
// };

//////////////////////////
// Date Functions
//////////////////////////

export const DATE_FORMAT = (
  source: SourceData,
  source_field: string,
  output_format: string,
  input_format = "auto"
) => {
  const val = source[source_field];
  if (!val) return val;

  let date;

  if (input_format === "auto") {
    date = dayjs(val);
  } else {
    date = dayjs(val, input_format);
  }

  if (!date.isValid()) return val;

  return date.format(output_format);
};


export const DATE_ADD = (
  source: SourceData,
  source_field: string,
  amount: number,
  unit: "days" | "weeks" | "months" | "years"
) => {
  const val = source[source_field];
  if (!val) return val;

  const date = dayjs(val);
  if (!date.isValid()) return val;

  return date.add(amount, unit).toISOString();
};


export const DATE_NOW = (
  output_format = "YYYY-MM-DDTHH:mm:ss[Z]"
) => {
  return dayjs().utc().format(output_format);
};


export const DATE_DIFF = (
  source: SourceData,
  start_field: string,
  end_field: string,
  unit: "days" | "months" | "years"
) => {
  const start = dayjs(source[start_field]);
  const end = dayjs(source[end_field]);

  if (!start.isValid() || !end.isValid()) return null;

  return end.diff(start, unit);
};


export const DATE_TRUNCATE = (
  source: SourceData,
  source_field: string,
  unit: "day" | "month" | "year"
) => {
  const val = source[source_field];
  if (!val) return val;

  const date = dayjs(val);
  if (!date.isValid()) return val;

  return date.startOf(unit).toISOString();
};