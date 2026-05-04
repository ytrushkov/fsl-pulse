import type { ConnectorKind } from "@workspace/api-zod";

export type { ConnectorKind };

/**
 * Per-connector feature flag registry. Each flag is a small, named on/off
 * switch over a heavy sub-call inside the runner — assessors flip them in
 * the create/edit dialog when an upstream API is rate-limited, lacks a
 * permission, or is otherwise unavailable for a given client install.
 *
 * Conventions:
 *  - Flags only gate *additional* calls. The runner's primary auth /
 *    identity check always runs so a misconfigured connector still fails
 *    fast at verify time.
 *  - Defaults are `true` for the whole registry. New deployments behave
 *    exactly like prior builds; assessors only need to touch flags when
 *    intentionally narrowing scope.
 *  - Flag values live in `connector.config.featureFlags` so we don't have
 *    to grow the connectors schema for every new toggle. The route layer
 *    sanitizes them on save (`sanitizeFeatureFlags`).
 *  - Adding a flag here does NOT add it to the openapi/codegen surface —
 *    `config` is `additionalProperties: true`. The cockpit reads the
 *    registry directly to render the toggles.
 */

export interface FeatureFlagDef {
  key: string;
  label: string;
  description: string;
  default: boolean;
}

export type FeatureFlagState = Record<string, boolean>;

const REGISTRY: Record<ConnectorKind, FeatureFlagDef[]> = {
  github: [
    {
      key: "pullWorkflows",
      label: "Pull workflow runs",
      description:
        "Sample recent GitHub Actions runs per repo for CI health signals. Disable on orgs without Actions.",
      default: true,
    },
    {
      key: "pullPRs",
      label: "Pull PR review + lead-time signals",
      description:
        "Reads recent merged pull requests to score lead time and review depth. Heavy on very large monorepos.",
      default: true,
    },
    {
      key: "pullIncidents",
      label: "Pull incident issues",
      description:
        "Searches repos for issues labelled `incident`/`outage` to estimate MTTR. Disable when this label is unused.",
      default: true,
    },
  ],
  gitlab: [
    {
      key: "pullPipelines",
      label: "Pull pipeline runs",
      description: "Samples recent CI pipelines per project for build health signals.",
      default: true,
    },
    {
      key: "pullMRs",
      label: "Pull merge request signals",
      description:
        "Reads recent merged MRs to score lead time and review depth. Heavy on very large groups.",
      default: true,
    },
    {
      key: "pullIncidents",
      label: "Pull incident issues",
      description:
        "Searches projects for issues labelled `incident`/`outage` to estimate MTTR.",
      default: true,
    },
  ],
  jira: [
    {
      key: "pullIncidents",
      label: "Pull incident tickets",
      description:
        "Reads recently resolved incident tickets in the configured project for MTTR signal.",
      default: true,
    },
  ],
  linear: [
    {
      key: "pullIncidents",
      label: "Pull incident issues",
      description:
        "Reads issues in the configured team for completion-time signal.",
      default: true,
    },
  ],
  cicd: [
    {
      key: "pullWorkflows",
      label: "Pull workflow / pipeline runs",
      description:
        "Enables the per-pipeline workflow lookup in the underlying CI provider. Disable on heavy installations.",
      default: true,
    },
  ],
  ai_tooling: [
    {
      key: "pullUsers",
      label: "Pull org user / seat counts",
      description:
        "Calls the provider's user/seat API to estimate adoption. Requires admin scope on the API key.",
      default: true,
    },
  ],
  azure_devops: [
    {
      key: "pullPipelines",
      label: "Pull pipeline runs",
      description:
        "Samples recent Azure Pipelines runs per project for deployment frequency / change failure rate signals.",
      default: true,
    },
    {
      key: "pullPRs",
      label: "Pull pull-request lead-time signals",
      description:
        "Reads recently completed PRs to score lead time. Disable on very large projects.",
      default: true,
    },
    {
      key: "pullIncidents",
      label: "Pull incident work items",
      description:
        "Reads work items tagged `incident`/`outage`/`p0`/`p1` for MTTR signal.",
      default: true,
    },
  ],
};

export function getFeatureFlagDefs(kind: ConnectorKind): FeatureFlagDef[] {
  return REGISTRY[kind] ?? [];
}

/**
 * Resolve the effective flag state for a connector given the persisted
 * config. Missing flags fall back to the registry default so existing
 * connectors created before a flag was introduced behave the same way they
 * did pre-flag.
 */
export function resolveFeatureFlags(
  kind: ConnectorKind,
  config: Record<string, unknown> | null | undefined,
): FeatureFlagState {
  const defs = getFeatureFlagDefs(kind);
  const stored = (config?.featureFlags ?? {}) as Record<string, unknown>;
  const out: FeatureFlagState = {};
  for (const def of defs) {
    const v = stored[def.key];
    out[def.key] = typeof v === "boolean" ? v : def.default;
  }
  return out;
}

/**
 * Strip unknown keys and coerce to booleans before persisting flags into
 * `config`. Defensive against UIs sending extra junk; the registry is the
 * source of truth for what's allowed.
 */
export function sanitizeFeatureFlags(
  kind: ConnectorKind,
  raw: unknown,
): FeatureFlagState | null {
  if (!raw || typeof raw !== "object") return null;
  const defs = getFeatureFlagDefs(kind);
  if (defs.length === 0) return null;
  const input = raw as Record<string, unknown>;
  const out: FeatureFlagState = {};
  for (const def of defs) {
    if (def.key in input) {
      out[def.key] = Boolean(input[def.key]);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
