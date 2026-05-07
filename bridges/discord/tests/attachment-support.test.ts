/**
 * Attachment-support tests — Discord bot accepts both images and PDFs
 * for the agent to read. Previously dropped PDFs silently because the
 * filter was image-only; this caused users who attached a PDF to wonder
 * why the agent didn't see it.
 *
 * Run: HARNESS_ROOT=$PWD npx --prefix bridges/discord tsx --test \
 *      bridges/discord/tests/attachment-support.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatAttachmentRef,
  isSupportedAttachment,
} from "../core-gateway.js";

describe("isSupportedAttachment", () => {
  it("accepts images by content-type", () => {
    assert.equal(isSupportedAttachment({ contentType: "image/png", name: null }), true);
    assert.equal(isSupportedAttachment({ contentType: "image/jpeg", name: "x" }), true);
    assert.equal(isSupportedAttachment({ contentType: "image/webp", name: "" }), true);
  });

  it("accepts images by file extension when content-type is missing", () => {
    for (const name of ["pic.png", "pic.PNG", "x.jpg", "x.jpeg", "anim.gif", "v.webp"]) {
      assert.equal(
        isSupportedAttachment({ contentType: null, name }),
        true,
        `${name} should be accepted`,
      );
    }
  });

  it("accepts PDFs by content-type", () => {
    assert.equal(
      isSupportedAttachment({ contentType: "application/pdf", name: null }),
      true,
    );
  });

  it("accepts PDFs by file extension when content-type is missing", () => {
    assert.equal(
      isSupportedAttachment({ contentType: null, name: "Holbach Study Guide.pdf" }),
      true,
    );
    // Case-insensitive match — Discord sometimes uppercases extensions.
    assert.equal(
      isSupportedAttachment({ contentType: null, name: "MIDTERM.PDF" }),
      true,
    );
  });

  it("rejects unsupported types", () => {
    const rejected = [
      { contentType: "video/mp4", name: "clip.mp4" },
      { contentType: "audio/mpeg", name: "song.mp3" },
      { contentType: "application/zip", name: "archive.zip" },
      { contentType: "text/plain", name: "notes.txt" },
      { contentType: null, name: "no-extension" },
      { contentType: null, name: null },
      { contentType: null, name: "" },
    ];
    for (const a of rejected) {
      assert.equal(isSupportedAttachment(a), false, `${a.name ?? "<null>"} should be rejected`);
    }
  });

  it("does not get confused by 'pdf' in the middle of a name", () => {
    // Only the trailing extension should count.
    assert.equal(
      isSupportedAttachment({ contentType: null, name: "pdf-notes.txt" }),
      false,
    );
  });
});

describe("formatAttachmentRef", () => {
  it("labels PDFs distinctly", () => {
    assert.equal(
      formatAttachmentRef("/tmp/abc.pdf"),
      "Use the Read tool to read this PDF: /tmp/abc.pdf",
    );
  });

  it("labels images distinctly", () => {
    for (const path of ["/x/a.png", "/x/a.jpg", "/x/a.JPEG", "/x/a.gif", "/x/a.webp"]) {
      assert.match(
        formatAttachmentRef(path),
        /Use the Read tool to view this image:/,
        `image label expected for ${path}`,
      );
    }
  });

  it("falls back to a generic file label for unknown extensions", () => {
    assert.equal(
      formatAttachmentRef("/tmp/data.bin"),
      "Use the Read tool to read this file: /tmp/data.bin",
    );
  });

  it("prefix differs between PDF and image so the agent picks the right Read affordance", () => {
    const pdf = formatAttachmentRef("/x/y.pdf");
    const img = formatAttachmentRef("/x/y.png");
    assert.notEqual(pdf, img);
    assert.match(pdf, /PDF/);
    assert.match(img, /image/);
  });
});
