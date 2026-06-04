import type { AuthedRequest } from "../middleware/auth";

export type AuditFields = {
  created_by: string | null;
  created_on: string | null;
  updated_by: string | null;
  updated_on: string | null;
};

/** Standard audit columns for SELECT lists (timestamps cast to text). */
export const AUDIT_SELECT_SQL = `
  created_by,
  created_on::text,
  updated_by,
  updated_on::text
`;

export function auditSelectSql(alias?: string): string {
  const p = alias ? `${alias}.` : "";
  return `
  ${p}created_by,
  ${p}created_on::text as created_on,
  ${p}updated_by,
  ${p}updated_on::text as updated_on
`;
}

export function auditActor(req?: AuthedRequest | null, fallback = "system"): string {
  return req?.user?.email ?? req?.user?.name ?? fallback;
}

export function mapAuditRow(row: Record<string, unknown>): AuditFields {
  return {
    created_by: (row.created_by as string | null) ?? null,
    created_on: (row.created_on as string | null) ?? null,
    updated_by: (row.updated_by as string | null) ?? null,
    updated_on: (row.updated_on as string | null) ?? null,
  };
}
