import { format, formatDistanceToNow } from "date-fns";

export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "N/A";
  return format(new Date(date), "MMM d, yyyy");
}

export function formatRelative(date: string | Date | null | undefined): string {
  if (!date) return "N/A";
  return formatDistanceToNow(new Date(date), { addSuffix: true });
}

export function formatCurrency(amount: number | null | undefined): string {
  if (amount == null) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatNumber(num: number | null | undefined): string {
  if (num == null) return "0";
  return new Intl.NumberFormat("en-US").format(num);
}
