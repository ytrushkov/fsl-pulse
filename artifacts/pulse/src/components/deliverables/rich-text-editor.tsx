import { useRef, useState } from "react";
import { Bold, Italic, Heading2, List, ListOrdered, Link as LinkIcon, Eye, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Lightweight markdown editor: a toolbar that wraps/inserts markdown around
 * the current selection plus a preview tab. We deliberately avoid pulling in
 * a full WYSIWYG dependency — the source of truth is markdown so that
 * snapshots, exports, and diffs stay readable.
 */
export function RichTextEditor({ value, onChange, rows = 10, placeholder, disabled }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [tab, setTab] = useState<"edit" | "preview">("edit");

  const wrap = (left: string, right = left) => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const before = value.slice(0, s);
    const sel = value.slice(s, e) || "text";
    const after = value.slice(e);
    const next = `${before}${left}${sel}${right}${after}`;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const cursor = before.length + left.length + sel.length;
      el.setSelectionRange(cursor, cursor);
    });
  };

  const linePrefix = (prefix: string) => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const start = value.lastIndexOf("\n", s - 1) + 1;
    const end = value.indexOf("\n", e);
    const lineEnd = end === -1 ? value.length : end;
    const block = value.slice(start, lineEnd);
    const replaced = block
      .split("\n")
      .map((l) => (l.startsWith(prefix) ? l : `${prefix}${l}`))
      .join("\n");
    onChange(value.slice(0, start) + replaced + value.slice(lineEnd));
  };

  return (
    <div className="border rounded-md overflow-hidden bg-background">
      <div className="flex items-center justify-between border-b bg-muted/40 px-2 py-1">
        <div className="flex items-center gap-0.5">
          <ToolbarButton title="Bold" onClick={() => wrap("**")} disabled={disabled || tab === "preview"}>
            <Bold className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton title="Italic" onClick={() => wrap("_")} disabled={disabled || tab === "preview"}>
            <Italic className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton title="Heading" onClick={() => linePrefix("## ")} disabled={disabled || tab === "preview"}>
            <Heading2 className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton title="Bullet list" onClick={() => linePrefix("- ")} disabled={disabled || tab === "preview"}>
            <List className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton title="Numbered list" onClick={() => linePrefix("1. ")} disabled={disabled || tab === "preview"}>
            <ListOrdered className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton title="Link" onClick={() => wrap("[", "](https://)")} disabled={disabled || tab === "preview"}>
            <LinkIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
        </div>
        <div className="flex items-center gap-0.5">
          <ToolbarButton title="Edit" onClick={() => setTab("edit")} active={tab === "edit"}>
            <Pencil className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton title="Preview" onClick={() => setTab("preview")} active={tab === "preview"}>
            <Eye className="h-3.5 w-3.5" />
          </ToolbarButton>
        </div>
      </div>
      {tab === "edit" ? (
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          disabled={disabled}
          className="font-mono text-sm border-0 rounded-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />
      ) : (
        <div className="prose prose-sm dark:prose-invert max-w-none p-4 min-h-[8rem]">
          <MarkdownPreview source={value} />
        </div>
      )}
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  title,
  disabled,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="sm"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="h-7 w-7 p-0"
    >
      {children}
    </Button>
  );
}

/**
 * Tiny, dependency-free markdown renderer covering the subset our
 * deliverables use: headings, bold/italic, links, bullet/numbered lists, and
 * paragraphs. Good enough for an in-app preview without pulling in remark.
 */
function MarkdownPreview({ source }: { source: string }) {
  const lines = source.split("\n");
  const out: React.ReactNode[] = [];
  let listBuf: { kind: "ul" | "ol"; items: string[] } | null = null;

  const flushList = (key: number) => {
    if (!listBuf) return;
    const items = listBuf.items.map((t, i) => (
      <li key={i} dangerouslySetInnerHTML={{ __html: inline(t) }} />
    ));
    out.push(listBuf.kind === "ul" ? <ul key={`l${key}`}>{items}</ul> : <ol key={`l${key}`}>{items}</ol>);
    listBuf = null;
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^##\s+/.test(line)) {
      flushList(i);
      out.push(<h2 key={i} dangerouslySetInnerHTML={{ __html: inline(line.replace(/^##\s+/, "")) }} />);
    } else if (/^#\s+/.test(line)) {
      flushList(i);
      out.push(<h1 key={i} dangerouslySetInnerHTML={{ __html: inline(line.replace(/^#\s+/, "")) }} />);
    } else if (/^-\s+/.test(line)) {
      if (!listBuf || listBuf.kind !== "ul") {
        flushList(i);
        listBuf = { kind: "ul", items: [] };
      }
      listBuf.items.push(line.replace(/^-\s+/, ""));
    } else if (/^\d+\.\s+/.test(line)) {
      if (!listBuf || listBuf.kind !== "ol") {
        flushList(i);
        listBuf = { kind: "ol", items: [] };
      }
      listBuf.items.push(line.replace(/^\d+\.\s+/, ""));
    } else if (line.trim() === "") {
      flushList(i);
    } else {
      flushList(i);
      out.push(<p key={i} dangerouslySetInnerHTML={{ __html: inline(line) }} />);
    }
  });
  flushList(lines.length);

  return <>{out}</>;
}

function inline(s: string) {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}
