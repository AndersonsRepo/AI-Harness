import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { marked } from "marked";
import puppeteer from "puppeteer-core";

const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const CSS = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    color: #2c2c2c;
    max-width: 100%;
    padding: 40px;
  }
  .header {
    border-bottom: 2px solid #5865F2;
    padding-bottom: 12px;
    margin-bottom: 24px;
  }
  .header h1 {
    font-size: 18px;
    color: #5865F2;
    margin: 0 0 4px 0;
  }
  .header .meta {
    font-size: 11px;
    color: #888;
  }
  h1, h2, h3 { color: #1a1a2e; }
  h1 { font-size: 22px; border-bottom: 1px solid #eee; padding-bottom: 8px; }
  h2 { font-size: 18px; }
  h3 { font-size: 15px; }
  code {
    background: #f4f4f8;
    padding: 2px 6px;
    border-radius: 4px;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 13px;
  }
  pre {
    background: #1e1e2e;
    color: #cdd6f4;
    padding: 16px;
    border-radius: 8px;
    overflow-x: auto;
    font-size: 12px;
    line-height: 1.5;
  }
  pre code {
    background: none;
    padding: 0;
    color: inherit;
  }
  blockquote {
    border-left: 3px solid #5865F2;
    margin: 12px 0;
    padding: 8px 16px;
    color: #555;
    background: #f8f8fc;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 12px 0;
  }
  th, td {
    border: 1px solid #ddd;
    padding: 8px 12px;
    text-align: left;
    font-size: 13px;
  }
  th { background: #f4f4f8; font-weight: 600; }
  tr:nth-child(even) { background: #fafafa; }
  ul, ol { padding-left: 24px; }
  li { margin-bottom: 4px; }
  a { color: #5865F2; text-decoration: none; }
  hr { border: none; border-top: 1px solid #eee; margin: 20px 0; }
`;

interface PdfOptions {
  agent?: string;
  channel?: string;
  query?: string;
}

export async function generateResponsePdf(
  markdown: string,
  opts: PdfOptions = {}
): Promise<string> {
  const html = await marked.parse(markdown);

  const now = new Date().toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const headerParts = [now];
  if (opts.agent) headerParts.push(`Agent: ${opts.agent}`);
  if (opts.channel) headerParts.push(`#${opts.channel}`);

  const fullHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>${CSS}</style></head>
<body>
  <div class="header">
    <h1>AI Harness Response</h1>
    <div class="meta">${headerParts.join(" · ")}</div>
    ${opts.query ? `<div class="meta" style="margin-top:4px;"><strong>Query:</strong> ${escapeHtml(opts.query)}</div>` : ""}
  </div>
  ${html}
</body>
</html>`;

  const tmpPath = path.join(
    os.tmpdir(),
    `harness-response-${Date.now()}.pdf`
  );

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: "networkidle0" });
    await page.pdf({
      path: tmpPath,
      format: "A4",
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
      printBackground: true,
    });
  } finally {
    if (browser) await browser.close();
  }

  return tmpPath;
}

export function cleanupPdf(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already deleted or missing
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
