/**
 * Branded PDF + DOCX renderers for finalized engagement deliverables.
 *
 * Output is intentionally simple text-on-page — pdfkit/docx don't render
 * markdown, so we walk the deliverable JSON and emit a structured
 * client-ready document with FullStack styling (color stripe, monospace
 * tabular data, section headings).
 */
import PDFDocument from "pdfkit";
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  AlignmentType,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
} from "docx";
import { STAGE_LABELS, type Dimension } from "./rubric";

// FullStack brand palette (ink + accent). Kept in this module only —
// matching the marketing site so the deliverable looks like an extension
// of the firm's brand rather than a generic export.
const BRAND_INK = "#0F172A";
const BRAND_ACCENT = "#7C3AED";
const BRAND_MUTED = "#64748B";

export interface DeliverableBundle {
  clientName: string;
  sponsor: string;
  exportedAt: string;
  exportVersion: number;
  finalizerEmail: string | null;
  scoring: {
    rubricVersion: string;
    overall: { score: number; stage: number; confidence: string };
    byDimension: Array<{
      dimension: string;
      stage: number;
      score: number;
      confidence: string;
      rationale: string;
    }>;
  } | null;
  deliverables: {
    heatmap: Array<{ dimension: string; currentStage: number; targetStage: number; confidence: string }>;
    gapAnalysis: Array<{
      dimension: Dimension;
      currentStage: number;
      targetStage: number;
      narrativeMd: string;
      gaps: string[];
    }>;
    actionPlan: Array<{
      initiative: string;
      dimension: string;
      priority: string;
      effort: string;
      impact: string;
      ownerRole: string;
      successMetric: string;
    }>;
    entryPoint: {
      recommendedStage: string;
      hyprAgents: Array<{ name: string; relevance: string }>;
      rationaleMd: string;
    } | null;
    npv: {
      inputs: Record<string, number>;
      scenarios: { base: { npv3yr: number; paybackMonths: number; irr: number } };
      leverBreakdown: Array<{ lever: string; savings: number }>;
    } | null;
  };
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

// ─── PDF ─────────────────────────────────────────────────────────────────

export async function renderEngagementPdf(b: DeliverableBundle): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: 56 });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  // Cover stripe
  doc.rect(0, 0, doc.page.width, 12).fill(BRAND_ACCENT);
  doc.fillColor(BRAND_INK);
  doc.moveDown(2);
  doc.fontSize(10).fillColor(BRAND_MUTED).text("FULLSTACK · AGENTIC MATURITY ASSESSMENT", { align: "left" });
  doc.moveDown(0.5);
  doc.fontSize(28).fillColor(BRAND_INK).text(b.clientName, { align: "left" });
  doc.fontSize(12).fillColor(BRAND_MUTED).text(`Sponsor: ${b.sponsor}`, { align: "left" });
  doc.fontSize(10).fillColor(BRAND_MUTED).text(
    `Exported ${b.exportedAt} · v${b.exportVersion}${b.finalizerEmail ? ` · finalized by ${b.finalizerEmail}` : ""}`,
  );

  doc.moveDown(2);

  // Overall scoring
  if (b.scoring) {
    section(doc, "Overall Maturity");
    doc.fontSize(12).fillColor(BRAND_INK).text(
      `Stage ${b.scoring.overall.stage} (${STAGE_LABELS[b.scoring.overall.stage] ?? "—"}) · score ${b.scoring.overall.score.toFixed(2)} · ${b.scoring.overall.confidence} confidence`,
    );
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor(BRAND_MUTED).text(`Rubric ${b.scoring.rubricVersion}`);
    doc.moveDown();
  }

  // Heatmap (per-dimension table)
  section(doc, "Dimension Heatmap");
  for (const row of b.deliverables.heatmap) {
    doc
      .fontSize(11)
      .fillColor(BRAND_INK)
      .text(
        `${row.dimension.padEnd(14)}  current ${row.currentStage} → target ${row.targetStage}  (${row.confidence})`,
      );
  }
  doc.moveDown();

  // Gap analysis
  section(doc, "Gap Analysis");
  for (const g of b.deliverables.gapAnalysis) {
    doc.fontSize(13).fillColor(BRAND_ACCENT).text(`${g.dimension}: stage ${g.currentStage} → ${g.targetStage}`);
    doc.fontSize(10).fillColor(BRAND_INK).text(stripMd(g.narrativeMd), { lineGap: 2 });
    if (g.gaps?.length) {
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor(BRAND_INK).text("Identified gaps:");
      for (const item of g.gaps) doc.text(`  • ${item}`);
    }
    doc.moveDown();
  }

  // Action plan
  section(doc, "90-Day Action Plan");
  for (const a of b.deliverables.actionPlan) {
    doc.fontSize(11).fillColor(BRAND_INK).text(`[${a.priority}] ${a.initiative}`);
    doc
      .fontSize(9)
      .fillColor(BRAND_MUTED)
      .text(
        `dim=${a.dimension} · effort=${a.effort} · impact=${a.impact} · owner=${a.ownerRole} · success=${a.successMetric}`,
      );
    doc.moveDown(0.4);
  }

  // Entry point
  if (b.deliverables.entryPoint) {
    section(doc, "PDLC Entry Point");
    doc.fontSize(12).fillColor(BRAND_INK).text(
      `Recommended stage: ${b.deliverables.entryPoint.recommendedStage}`,
    );
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor(BRAND_INK).text(stripMd(b.deliverables.entryPoint.rationaleMd));
    if (b.deliverables.entryPoint.hyprAgents?.length) {
      doc.moveDown(0.4);
      doc.fontSize(10).fillColor(BRAND_INK).text("Suggested Hypr agents:");
      for (const a of b.deliverables.entryPoint.hyprAgents) {
        doc.text(`  • ${a.name} — ${a.relevance}`);
      }
    }
    doc.moveDown();
  }

  // NPV
  if (b.deliverables.npv) {
    section(doc, "Business Case (NPV)");
    const base = b.deliverables.npv.scenarios.base;
    doc.fontSize(11).fillColor(BRAND_INK).text(
      `3-Year NPV (base): ${fmtCurrency(base.npv3yr)} · Payback ${base.paybackMonths} mo · IRR ${Math.round(base.irr * 100)}%`,
    );
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor(BRAND_INK).text("Value levers:");
    for (const lever of b.deliverables.npv.leverBreakdown) {
      doc.text(`  • ${lever.lever} — ${fmtCurrency(lever.savings)}/yr`);
    }
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor(BRAND_MUTED).text("Inputs:");
    for (const [k, v] of Object.entries(b.deliverables.npv.inputs)) {
      doc.text(`  ${k}: ${typeof v === "number" ? v : String(v)}`);
    }
  }

  doc.end();
  return done;
}

function section(doc: PDFKit.PDFDocument, title: string): void {
  if (doc.y > doc.page.height - 200) doc.addPage();
  doc.moveDown(0.5);
  doc.fontSize(16).fillColor(BRAND_INK).text(title);
  doc.moveTo(doc.x, doc.y).lineTo(doc.x + 80, doc.y).strokeColor(BRAND_ACCENT).lineWidth(2).stroke();
  doc.moveDown(0.5);
}

function stripMd(s: string): string {
  return s
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

// ─── DOCX ─────────────────────────────────────────────────────────────────

export async function renderEngagementDocx(b: DeliverableBundle): Promise<Buffer> {
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [
        new TextRun({
          text: "FULLSTACK · AGENTIC MATURITY ASSESSMENT",
          bold: true,
          color: BRAND_MUTED.replace("#", ""),
          size: 18,
        }),
      ],
    }),
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: b.clientName, color: BRAND_INK.replace("#", "") })],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `Sponsor: ${b.sponsor}`, color: BRAND_MUTED.replace("#", "") }),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Exported ${b.exportedAt} · v${b.exportVersion}${b.finalizerEmail ? ` · finalized by ${b.finalizerEmail}` : ""}`,
          color: BRAND_MUTED.replace("#", ""),
          size: 18,
        }),
      ],
    }),
    new Paragraph({ text: "" }),
  );

  if (b.scoring) {
    children.push(
      heading("Overall Maturity"),
      new Paragraph({
        children: [
          new TextRun({
            text: `Stage ${b.scoring.overall.stage} (${STAGE_LABELS[b.scoring.overall.stage] ?? "—"}) · score ${b.scoring.overall.score.toFixed(2)} · ${b.scoring.overall.confidence} confidence`,
            bold: true,
          }),
        ],
      }),
      new Paragraph({
        children: [new TextRun({ text: `Rubric ${b.scoring.rubricVersion}`, italics: true, color: BRAND_MUTED.replace("#", "") })],
      }),
    );
  }

  children.push(heading("Dimension Heatmap"));
  for (const row of b.deliverables.heatmap) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${row.dimension}: current ${row.currentStage} → target ${row.targetStage} (${row.confidence})`,
          }),
        ],
      }),
    );
  }

  children.push(heading("Gap Analysis"));
  for (const g of b.deliverables.gapAnalysis) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: [
          new TextRun({ text: `${g.dimension}: stage ${g.currentStage} → ${g.targetStage}`, color: BRAND_ACCENT.replace("#", "") }),
        ],
      }),
      new Paragraph({ text: stripMd(g.narrativeMd) }),
    );
    for (const item of g.gaps ?? []) {
      children.push(new Paragraph({ text: `• ${item}`, bullet: { level: 0 } }));
    }
  }

  children.push(heading("90-Day Action Plan"));
  for (const a of b.deliverables.actionPlan) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `[${a.priority}] `, bold: true, color: BRAND_ACCENT.replace("#", "") }),
          new TextRun({ text: a.initiative }),
        ],
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: `dim=${a.dimension} · effort=${a.effort} · impact=${a.impact} · owner=${a.ownerRole} · success=${a.successMetric}`,
            color: BRAND_MUTED.replace("#", ""),
            size: 18,
          }),
        ],
      }),
    );
  }

  if (b.deliverables.entryPoint) {
    children.push(
      heading("PDLC Entry Point"),
      new Paragraph({
        children: [new TextRun({ text: `Recommended stage: ${b.deliverables.entryPoint.recommendedStage}`, bold: true })],
      }),
      new Paragraph({ text: stripMd(b.deliverables.entryPoint.rationaleMd) }),
    );
    for (const a of b.deliverables.entryPoint.hyprAgents ?? []) {
      children.push(new Paragraph({ text: `• ${a.name} — ${a.relevance}`, bullet: { level: 0 } }));
    }
  }

  const sectionChildren: Array<Paragraph | Table> = [...children];
  if (b.deliverables.npv) {
    const base = b.deliverables.npv.scenarios.base;
    sectionChildren.push(
      heading("Business Case (NPV)"),
      new Paragraph({
        children: [
          new TextRun({
            text: `3-Year NPV (base): ${fmtCurrency(base.npv3yr)} · Payback ${base.paybackMonths} mo · IRR ${Math.round(base.irr * 100)}%`,
            bold: true,
          }),
        ],
      }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: Object.entries(b.deliverables.npv.inputs).map(
          ([k, v]) =>
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph({ text: k })] }),
                new TableCell({ children: [new Paragraph({ text: String(v) })] }),
              ],
            }),
        ),
      }),
    );
  }
  const doc = new Document({ sections: [{ children: sectionChildren }] });
  return Packer.toBuffer(doc);
}

function heading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, color: BRAND_INK.replace("#", "") })],
  });
}
