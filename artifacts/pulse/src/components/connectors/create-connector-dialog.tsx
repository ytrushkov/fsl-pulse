import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useCreateConnector, getListConnectorsQueryKey, ConnectorKind } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

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

const formSchema = z.object({
  kind: z.enum([ConnectorKind.github, ConnectorKind.gitlab, ConnectorKind.jira, ConnectorKind.linear, ConnectorKind.cicd, ConnectorKind.ai_tooling]),
  provider: z.string().min(1, "Provider is required"),
  label: z.string().min(1, "Label is required"),
  token: z.string().optional(),
});

interface CreateConnectorDialogProps {
  engagementId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateConnectorDialog({ engagementId, open, onOpenChange }: CreateConnectorDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      kind: ConnectorKind.github,
      provider: "GitHub",
      label: "",
      token: "",
    },
  });

  const createConnector = useCreateConnector();

  function onSubmit(values: z.infer<typeof formSchema>) {
    createConnector.mutate(
      { id: engagementId, data: { ...values, config: {} } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListConnectorsQueryKey(engagementId) });
          toast({
            title: "Connector added",
            description: "Successfully added new connector.",
          });
          onOpenChange(false);
          form.reset();
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Error",
            description: "Failed to add connector.",
          });
        },
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Add Connector
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Add Connector</DialogTitle>
          <DialogDescription>
            Connect a system to extract automated evidence.
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
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={ConnectorKind.github}>GitHub</SelectItem>
                      <SelectItem value={ConnectorKind.gitlab}>GitLab</SelectItem>
                      <SelectItem value={ConnectorKind.jira}>Jira</SelectItem>
                      <SelectItem value={ConnectorKind.linear}>Linear</SelectItem>
                      <SelectItem value={ConnectorKind.cicd}>CI/CD</SelectItem>
                      <SelectItem value={ConnectorKind.ai_tooling}>AI Tooling</SelectItem>
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
                    <Input placeholder="e.g. Core Engineering GitHub" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="provider"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider Name</FormLabel>
                  <FormControl>
                    <Input placeholder="GitHub, Jira, etc." {...field} />
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
                  <FormLabel>Access Token (Optional)</FormLabel>
                  <FormControl>
                    <Input type="password" placeholder="ghp_..." {...field} />
                  </FormControl>
                  <FormDescription>
                    Provide token now or configure later.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="submit"
                disabled={createConnector.isPending}
              >
                {createConnector.isPending ? "Adding..." : "Add Connector"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
