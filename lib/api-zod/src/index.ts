// types/ contains TS-only declarations (request/response/param shapes); api.ts
// contains the runtime zod schemas. Some endpoint param schemas exist in both
// (e.g. GetEngagementActivityParams as a TS type AND a zod object) — the
// `export type *` form keeps only the type half from types/ so the runtime zod
// const wins, eliminating the duplicate-export collision.
export type * from "./generated/types";
export * from "./generated/api";
