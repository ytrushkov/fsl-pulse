import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useCreateConnector,
  useVerifyConnectorConfig,
  getListConnectorsQueryKey,
  ConnectorKind,
  type ConnectorVerifyResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Plus, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

// Per-kind config catalog. Keeping this declarative (instead of one giant
// switch in JSX) makes it easy to add/edit a kind without touching layout.
// `provider` is the connector's logical provider; for kinds with a provider
// dropdown (cicd, ai_tooling) we resolve it from the selected sub-provider.
type ConfigFieldType = "text" | "url" | "email" | "number";
interface ConfigField {
  key: string;
  label: string;
  type: ConfigFieldType;
  placeholder?: string;
  description?: string;
  required?: boolean;
  defaultValue?: string;
  // Show this field only when provider matches one of the listed values.
  // Used for sub-provider conditional fields inside cicd / ai_tooling.
  whenProvider?: string[];
}

interface KindSpec {
  kind: ConnectorKind;
  label: string;
  defaultProvider: string;
  // For kinds where the provider is selected in the wizard rather than fixed.
  providerOptions?: Array<{ value: string; label: string }>;
  tokenLabel: string;
  tokenPlaceholder: string;
  tokenHelp: string;
  tokenDocsUrl: string;
  fields: ConfigField[];
}

const KIND_SPECS: Record<ConnectorKind, KindSpec> = {
  [ConnectorKind.github]: {
    kind: ConnectorKind.github,
    label: "GitHub",
    defaultProvider: "GitHub",
    tokenLabel: "Personal access token",
    tokenPlaceholder: "ghp_…",
    tokenHelp:
      "Needs scopes: repo (read), read:org, workflow. Fine-grained tokens also work with equivalent read permissions.",
    tokenDocsUrl: "https://github.com/settings/tokens",
    fields: [
      {
        key: "org",
        label: "Organization",
        type: "text",
        placeholder: "acme-corp",
        description: "GitHub organization slug whose repos this connector should sample.",
        required: true,
      },
    ],
  },
  [ConnectorKind.gitlab]: {
    kind: ConnectorKind.gitlab,
    label: "GitLab",
    defaultProvider: "GitLab",
    tokenLabel: "Personal access token",
    tokenPlaceholder: "glpat-…",
    tokenHelp:
      "Needs scopes: read_api, read_repository. For self-hosted GitLab, create the token at <baseUrl>/-/user_settings/personal_access_tokens.",
    tokenDocsUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    fields: [
      {
        key: "baseUrl",
        label: "Base URL",
        type: "url",
        placeholder: "https://gitlab.com",
        description: "Use the default for SaaS GitLab, or your self-hosted instance URL.",
        defaultValue: "https://gitlab.com",
        required: true,
      },
      {
        key: "group",
        label: "Group",
        type: "text",
        placeholder: "engineering",
        description: "Top-level group whose projects should be sampled.",
        required: true,
      },
    ],
  },
  [ConnectorKind.jira]: {
    kind: ConnectorKind.jira,
    label: "Jira",
    defaultProvider: "Jira",
    tokenLabel: "API token",
    tokenPlaceholder: "ATATT…",
    tokenHelp:
      "Create an API token from id.atlassian.com → Security → API tokens. Combined with your account email it gives Basic auth into Jira's REST API.",
    tokenDocsUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    fields: [
      {
        key: "baseUrl",
        label: "Base URL",
        type: "url",
        placeholder: "https://acme.atlassian.net",
        description: "Your Jira Cloud site URL (no trailing slash).",
        required: true,
      },
      {
        key: "email",
        label: "Account email",
        type: "email",
        placeholder: "you@acme.com",
        description: "The Atlassian account the API token was issued to.",
        required: true,
      },
      {
        key: "project",
        label: "Project key",
        type: "text",
        placeholder: "ENG",
        description: "Optional. If set, sampling and verify scope to this single project.",
      },
    ],
  },
  [ConnectorKind.linear]: {
    kind: ConnectorKind.linear,
    label: "Linear",
    defaultProvider: "Linear",
    tokenLabel: "API key",
    tokenPlaceholder: "lin_api_…",
    tokenHelp:
      "Create a personal API key at linear.app → Settings → API. Read access to issues and teams is sufficient.",
    tokenDocsUrl: "https://linear.app/settings/api",
    fields: [
      {
        key: "teamKey",
        label: "Team key",
        type: "text",
        placeholder: "ENG",
        description: "Optional. If set, verify confirms the credential can see this team.",
      },
    ],
  },
  [ConnectorKind.cicd]: {
    kind: ConnectorKind.cicd,
    label: "CI / CD",
    defaultProvider: "github_actions",
    providerOptions: [
      { value: "github_actions", label: "GitHub Actions" },
      { value: "circleci", label: "CircleCI" },
      { value: "gitlab_ci", label: "GitLab CI" },
      { value: "jenkins", label: "Jenkins" },
    ],
    tokenLabel: "API token",
    tokenPlaceholder: "ghp_… or circle-token or glpat-… or Jenkins API token",
    tokenHelp:
      "GitHub Actions uses a GitHub PAT (repo + workflow). CircleCI uses a personal API token. GitLab CI reuses a GitLab PAT (read_api). Jenkins uses the per-user API token paired with the username field.",
    tokenDocsUrl: "https://github.com/settings/tokens",
    fields: [
      {
        key: "org",
        label: "GitHub organization",
        type: "text",
        placeholder: "acme-corp",
        description: "Org whose Actions workflow runs we'll sample.",
        required: true,
        whenProvider: ["github_actions"],
      },
      {
        key: "baseUrl",
        label: "GitLab base URL",
        type: "url",
        placeholder: "https://gitlab.com",
        defaultValue: "https://gitlab.com",
        required: true,
        whenProvider: ["gitlab_ci"],
      },
      {
        key: "group",
        label: "GitLab group",
        type: "text",
        placeholder: "engineering",
        required: true,
        whenProvider: ["gitlab_ci"],
      },
      {
        key: "baseUrl",
        label: "Jenkins base URL",
        type: "url",
        placeholder: "https://jenkins.acme.com",
        description: "Public Jenkins controller URL (no trailing slash).",
        required: true,
        whenProvider: ["jenkins"],
      },
      {
        key: "username",
        label: "Jenkins username",
        type: "text",
        placeholder: "ci-readonly",
        description: "User the API token belongs to. Combined into HTTP Basic auth.",
        required: true,
        whenProvider: ["jenkins"],
      },
      {
        key: "jobFilter",
        label: "Job filter (optional)",
        type: "text",
        placeholder: "^prod-.*",
        description:
          "Optional regex matched against the full job path (e.g. 'folder/job'). When set, only matching jobs contribute to DORA metrics.",
        whenProvider: ["jenkins"],
      },
    ],
  },
  [ConnectorKind.ai_tooling]: {
    kind: ConnectorKind.ai_tooling,
    label: "AI tooling",
    defaultProvider: "openai",
    providerOptions: [
      { value: "openai", label: "OpenAI" },
      { value: "anthropic", label: "Anthropic" },
      { value: "cursor", label: "Cursor (admin API)" },
      { value: "claude_code", label: "Claude Code (Anthropic admin API)" },
      { value: "windsurf", label: "Windsurf (CSV upload)" },
      { value: "amazon_q", label: "Amazon Q (CSV upload)" },
    ],
    tokenLabel: "API key",
    tokenPlaceholder: "sk-…",
    tokenHelp:
      "Use an admin/org-scoped key when available so usage data can be queried. Read-only inference keys work but adoption metrics will be unavailable. CSV-only providers (Windsurf, Amazon Q) ignore the token — leave it blank.",
    tokenDocsUrl: "https://platform.openai.com/api-keys",
    fields: [
      {
        key: "engineerCount",
        label: "Engineer count (denominator)",
        type: "number",
        placeholder: "e.g. 80",
        description:
          "Optional. Used to compute adoption rate (active AI users ÷ engineer count). Shared across every AI-tooling provider.",
      },
      {
        key: "csvArtifactId",
        label: "Usage CSV artifact ID (optional)",
        type: "text",
        placeholder: "uuid of an uploaded artifact",
        description:
          "Required for Windsurf/Amazon Q (no public admin API). Optional fallback for the other providers. Upload a CSV via the Artifacts tab with header: user,active_days,suggestions_seen,suggestions_accepted — then paste the artifact's ID here.",
      },
    ],
  },
  [ConnectorKind.azure_devops]: {
    kind: ConnectorKind.azure_devops,
    label: "Azure DevOps",
    defaultProvider: "Azure DevOps",
    tokenLabel: "Personal access token",
    tokenPlaceholder: "<PAT>",
    tokenHelp:
      "Create a PAT at dev.azure.com → User Settings → Personal Access Tokens. Needs Code (read), Work Items (read), and Build (read) scopes — Read-all also works.",
    tokenDocsUrl: "https://dev.azure.com/_usersSettings/tokens",
    fields: [
      {
        key: "baseUrl",
        label: "Base URL",
        type: "url",
        placeholder: "https://dev.azure.com",
        description: "Use the default for SaaS Azure DevOps, or your self-hosted Azure DevOps Server URL.",
        defaultValue: "https://dev.azure.com",
        required: true,
      },
      {
        key: "organization",
        label: "Organization",
        type: "text",
        placeholder: "acme-corp",
        description: "Azure DevOps organization slug (the URL segment after dev.azure.com/).",
        required: true,
      },
      {
        key: "project",
        label: "Project",
        type: "text",
        placeholder: "Platform",
        description: "Project name whose repos, PRs, work items, and pipelines this connector should sample.",
        required: true,
      },
      {
        key: "team",
        label: "Team",
        type: "text",
        placeholder: "Platform Team",
        description: "Optional. Recorded for context; queries are scoped to the project.",
      },
    ],
  },
};

const KIND_OPTIONS: Array<{ value: ConnectorKind; label: string }> = (
  Object.keys(KIND_SPECS) as ConnectorKind[]
).map((k) => ({ value: k, label: KIND_SPECS[k].label }));

// We deliberately keep config validation loose at the form layer (server is
// the source of truth for required-ness via verify). Empty string is fine and
// just means "not configured yet" — this matches the existing edit dialog.
const formSchema = z.object({
  kind: z.enum([
    ConnectorKind.github,
    ConnectorKind.gitlab,
    ConnectorKind.jira,
    ConnectorKind.linear,
    ConnectorKind.cicd,
    ConnectorKind.ai_tooling,
    ConnectorKind.azure_devops,
  ]),
  provider: z.string().min(1, "Provider is required"),
  label: z.string().min(1, "Label is required"),
  token: z.string().optional(),
  config: z.record(z.string()).default({}),
});

type FormValues = z.infer<typeof formSchema>;

interface CreateConnectorDialogProps {
  engagementId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateConnectorDialog({ engagementId, open, onOpenChange }: CreateConnectorDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [verifyResult, setVerifyResult] = useState<ConnectorVerifyResult | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      kind: ConnectorKind.github,
      provider: KIND_SPECS[ConnectorKind.github].defaultProvider,
      label: "",
      token: "",
      config: {},
    },
  });

  const kind = useWatch({ control: form.control, name: "kind" });
  const provider = useWatch({ control: form.control, name: "provider" });
  const spec = KIND_SPECS[kind as ConnectorKind] ?? KIND_SPECS[ConnectorKind.github];

  // When kind changes, reset the provider + config so we never leave a
  // stale "org" value sitting on a Jira connector. We *don't* clear the
  // typed-in label or token, since those are kind-agnostic.
  useEffect(() => {
    setVerifyResult(null);
    const next = KIND_SPECS[kind as ConnectorKind];
    if (!next) return;
    const defaults: Record<string, string> = {};
    for (const f of next.fields) {
      if (f.defaultValue) defaults[f.key] = f.defaultValue;
    }
    form.setValue("provider", next.defaultProvider, { shouldValidate: true });
    form.setValue("config", defaults, { shouldValidate: true });
  }, [kind, form]);

  // Visible fields for the current (kind, provider) combo.
  const visibleFields = useMemo(
    () =>
      spec.fields.filter(
        (f) => !f.whenProvider || f.whenProvider.includes(String(provider)),
      ),
    [spec, provider],
  );

  const createConnector = useCreateConnector();
  const verifyConfig = useVerifyConnectorConfig();

  function buildConfigPayload(values: FormValues): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of visibleFields) {
      const raw = values.config?.[f.key];
      if (raw === undefined || raw === "") continue;
      if (f.type === "number") {
        const n = Number(raw);
        if (Number.isFinite(n)) out[f.key] = n;
      } else {
        out[f.key] = raw;
      }
    }
    return out;
  }

  async function onVerify() {
    setVerifyResult(null);
    const values = form.getValues();
    // Surface required-field errors before we waste a network round-trip.
    let missing = false;
    for (const f of visibleFields) {
      if (f.required && !(values.config?.[f.key] ?? "").trim()) {
        form.setError(`config.${f.key}` as const, {
          type: "manual",
          message: `${f.label} is required`,
        });
        missing = true;
      }
    }
    if (missing) return;
    try {
      const result = await verifyConfig.mutateAsync({
        id: engagementId,
        data: {
          kind: values.kind,
          provider: values.provider,
          token: values.token ?? "",
          config: buildConfigPayload(values),
        },
      });
      setVerifyResult(result);
    } catch (err) {
      setVerifyResult({
        ok: false,
        message: err instanceof Error ? err.message : "Verify request failed",
      });
    }
  }

  function onSubmit(values: FormValues) {
    createConnector.mutate(
      {
        id: engagementId,
        data: {
          kind: values.kind,
          provider: values.provider,
          label: values.label,
          token: values.token,
          config: buildConfigPayload(values),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListConnectorsQueryKey(engagementId) });
          toast({
            title: "Connector added",
            description: "Successfully added new connector.",
          });
          onOpenChange(false);
          form.reset();
          setVerifyResult(null);
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Error",
            description: err instanceof Error ? err.message : "Failed to add connector.",
          });
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          form.reset();
          setVerifyResult(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Add Connector
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add Connector</DialogTitle>
          <DialogDescription>
            Connect a system to extract automated evidence. Each type asks only
            for the fields it actually needs.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Connector Type</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {KIND_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Label</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={`e.g. Core Engineering ${spec.label}`}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    A human-friendly name shown in the connector list.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {spec.providerOptions ? (
              <FormField
                control={form.control}
                name="provider"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Provider</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a provider" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {spec.providerOptions!.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}

            {visibleFields.map((f) => (
              <FormField
                key={`${kind}-${f.key}`}
                control={form.control}
                name={`config.${f.key}` as const}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {f.label}
                      {f.required ? <span className="text-destructive"> *</span> : null}
                    </FormLabel>
                    <FormControl>
                      <Input
                        type={f.type === "number" ? "number" : f.type === "email" ? "email" : "text"}
                        placeholder={f.placeholder}
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    {f.description ? <FormDescription>{f.description}</FormDescription> : null}
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}

            <FormField
              control={form.control}
              name="token"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{spec.tokenLabel} (optional)</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder={spec.tokenPlaceholder}
                      autoComplete="off"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {spec.tokenHelp}{" "}
                    <a
                      href={spec.tokenDocsUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline"
                    >
                      Where to get this <ExternalLink className="h-3 w-3" />
                    </a>
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {verifyResult ? (
              <div
                className={`flex items-start gap-2 rounded border p-3 text-sm ${
                  verifyResult.ok
                    ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                    : "border-destructive/40 bg-destructive/5 text-destructive"
                }`}
                role="status"
                data-testid="verify-result"
              >
                {verifyResult.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
                ) : (
                  <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
                )}
                <div>
                  <div className="font-medium">
                    {verifyResult.ok ? "Credential verified" : "Verify failed"}
                  </div>
                  {verifyResult.message ? (
                    <div className="text-xs opacity-80">{verifyResult.message}</div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={onVerify}
                disabled={verifyConfig.isPending || createConnector.isPending}
              >
                {verifyConfig.isPending ? "Verifying…" : "Verify credential"}
              </Button>
              <Button type="submit" disabled={createConnector.isPending}>
                {createConnector.isPending ? "Adding..." : "Add Connector"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
