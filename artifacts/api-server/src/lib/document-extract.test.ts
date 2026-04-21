import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { extractDocxText, extractPptxText } from "./document-extract";

describe("extractDocxText", () => {
  it("pulls plain text out of a real .docx", async () => {
    const doc = new Document({
      sections: [
        {
          properties: {},
          children: [
            new Paragraph({ children: [new TextRun("Hello world.")] }),
            new Paragraph({
              children: [new TextRun("Strategy & roadmap > Q3.")],
            }),
          ],
        },
      ],
    });
    const buf = await Packer.toBuffer(doc);
    const text = await extractDocxText(buf);
    expect(text).toContain("Hello world.");
    expect(text).toContain("Strategy & roadmap > Q3.");
  });
});

describe("extractPptxText", () => {
  it("pulls slide text in slide order and decodes entities", async () => {
    // Hand-rolled minimal PPTX — only the slide XML files are needed by our
    // extractor; we don't need the full content-types/rels machinery to test
    // the parser since it scans by path pattern.
    const zip = new JSZip();
    zip.file(
      "ppt/slides/slide2.xml",
      `<p:sld><p:cSld><p:spTree>
        <p:sp><p:txBody><a:p><a:r><a:t>Second slide &amp; notes</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sld>`,
    );
    zip.file(
      "ppt/slides/slide1.xml",
      `<p:sld><p:cSld><p:spTree>
        <p:sp><p:txBody><a:p><a:r><a:t>Title here</a:t></a:r></a:p></p:txBody></p:sp>
        <p:sp><p:txBody><a:p><a:r><a:t>Bullet one</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sld>`,
    );
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const text = await extractPptxText(buf);
    // Slide 1 must come before slide 2 even though we inserted out of order.
    const idx1 = text.indexOf("Title here");
    const idx2 = text.indexOf("Second slide & notes");
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(text).toContain("Bullet one");
  });

  it("returns empty string for a deck with no slides", async () => {
    const zip = new JSZip();
    zip.file("ppt/notes/notes1.xml", "<x/>");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    expect(await extractPptxText(buf)).toBe("");
  });
});
