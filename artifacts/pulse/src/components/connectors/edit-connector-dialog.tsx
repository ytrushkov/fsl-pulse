import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useUpdateConnector,
  getListConnectorsQueryKey,
  type Connector,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

// Common cadences (minutes). The server validates 5 ≤ x ≤ 30 days; this list
// covers the realistic options without overwhelming assessors.
const CADENCE_OPTIONS = [
  { value: "60", label: "Hourly" },
  { value: "360", label: "Every 6 hours" },
  { value: "720", label: "Every 12 hours" },
  { value: "1440", label: "Daily" },
  { value: "10080", label: "Weekly" },
];

const formSchema = z.object({
  label: z.string().min(1, "Label is required"),
  token: z.string().optional(),
  scheduleEnabled: z.boolean(),
  scheduleCadenceMinutes: z.string(),
});

interface EditConnectorDialogProps {
  connector: Connector | null;
  engagementId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditConnectorDialog({
  connector,
  engagementId,
  open,
  onOpenChange,
}: EditConnectorDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateConnector = useUpdateConnector();
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({});

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      label: "",
      token: "",
      scheduleEnabled: false,
      scheduleCadenceMinutes: "1440",
    },
  });

  // The server sends `featureFlagDefs` alongside `featureFlags` so the UI
  // can render the right toggle list for the connector's kind without
  // hard-coding it here. Definitions live in connector-flags.ts on the
  // server.
  type FlagDef = { key: string; label: string; description: string; default: boolean };
  const flagDefs: FlagDef[] = useMemo(() => {
    const cfg = (connector?.config as Record<string, unknown> | null) ?? {};
    const raw = (cfg.featureFlagDefs as FlagDef[]) ?? [];
    return Array.isArray(raw) ? raw : [];
  }, [connector]);

  // Re-seed the form whenever the dialog is opened against a different
  // connector. Using `reset` instead of `defaultValues` lets the same dialog
  // instance edit any row from the table.
  useEffect(() => {
    if (connector && open) {
      form.reset({
        label: connector.label,
        token: "",
        scheduleEnabled: Boolean(connector.scheduleEnabled),
        scheduleCadenceMinutes: String(connector.scheduleCadenceMinutes ?? 1440),
      });
      const cfg = (connector.config as Record<string, unknown> | null) ?? {};
      const stored = (cfg.featureFlags as Record<string, boolean>) ?? {};
      const seeded: Record<string, boolean> = {};
      for (const def of flagDefs) {
        const v = stored[def.key];
        seeded[def.key] = typeof v === "boolean" ? v : def.default;
      }
      setFeatureFlags(seeded);
    }
  }, [connector, open, form, flagDefs]);

  if (!connector) return null;

  function onSubmit(values: z.infer<typeof formSchema>) {
    if (!connector) return;
    const data: Record<string, unknown> = {
      label: values.label,
      scheduleEnabled: values.scheduleEnabled,
      scheduleCadenceMinutes: Number(values.scheduleCadenceMinutes),
    };
    // Only send `token` when the assessor actually typed a new value — empty
    // string would be treated as a rotation request server-side, which is a
    // critical audit event.
    if (values.token && values.token.length > 0) {
      data.token = values.token;
    }
    // Preserve every other config field — PATCH treats `config` as a full
    // replacement — and write back the (possibly toggled) feature flags.
    if (flagDefs.length > 0) {
      const existingCfg =
        (connector.config as Record<string, unknown> | null) ?? {};
      const flags: Record<string, boolean> = {};
      for (const def of flagDefs) {
        flags[def.key] = featureFlags[def.key] ?? def.default;
      }
      const { tokenMask: _tm, featureFlagDefs: _ffd, ...persistable } =
        existingCfg as Record<string, unknown> & {
          tokenMask?: unknown;
          featureFlagDefs?: unknown;
        };
      data.config = { ...persistable, featureFlags: flags };
    }
    updateConnector.mutate(
      { connectorId: connector.id, data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListConnectorsQueryKey(engagementId),
          });
          toast({
            title: "Connector updated",
            description: values.token
              ? "Token rotated and settings saved."
              : "Settings saved.",
          });
          onOpenChange(false);
          form.reset();
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Update failed",
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Configure connector</DialogTitle>
          <DialogDescription>
            Rotate credentials, rename, or change how often this connector runs
            in the background.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Label</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="token"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Rotate access token</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder="Leave blank to keep current token"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Replaces the stored credential. Logged as a critical event.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="scheduleEnabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded border p-3">
                  <div>
                    <FormLabel className="text-base">
                      Run on a schedule
                    </FormLabel>
                    <FormDescription>
                      Background runs collect fresh signals automatically.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            {flagDefs.length > 0 ? (
              <div className="space-y-2 rounded border p-3">
                <div className="text-sm font-medium">Data sources</div>
                <p className="text-xs text-muted-foreground">
                  Disable any source the upstream API can&apos;t serve. The
                  runner records the active set with every run.
                </p>
                {flagDefs.map((def) => (
                  <div
                    key={def.key}
                    className="flex items-start justify-between gap-3 pt-2"
                    data-testid={`feature-flag-${def.key}`}
                  >
                    <div className="space-y-0.5">
                      <div className="text-sm">{def.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {def.description}
                      </div>
                    </div>
                    <Switch
                      checked={featureFlags[def.key] ?? def.default}
                      onCheckedChange={(v) =>
                        setFeatureFlags((prev) => ({ ...prev, [def.key]: v }))
                      }
                    />
                  </div>
                ))}
              </div>
            ) : null}
            <FormField
              control={form.control}
              name="scheduleCadenceMinutes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Cadence</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CADENCE_OPTIONS.map((o) => (
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
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updateConnector.isPending}>
                {updateConnector.isPending ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
