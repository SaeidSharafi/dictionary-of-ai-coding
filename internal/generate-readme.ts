#!/usr/bin/env -S npx tsx
// Generate README.md from internal/Curriculum.md + dictionary/*.md + internal/README.template.md.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CURRICULUM = join(HERE, "Curriculum.md");
const TEMPLATE = join(HERE, "README.template.md");
const DICT_DIR = join(ROOT, "dictionary");
const OUTPUT = join(ROOT, "README.md");
const MARKER = "<!-- CURRICULUM -->";
const TOC_MARKER = "<!-- TOC -->";

const SECTION_RE = /^## Section \d+ — .+$/;
const BULLET_RE = /^- (.+)$/;
// Link to another dictionary entry: [text](./Target.md). Target may be %20-encoded.
const LINK_RE = /\[([^\]]+)\]\(\.\/([^)]+)\.md\)/g;
// Any relative markdown link, to distinguish entry links from broken/non-entry ones.
const ANY_RELATIVE_LINK_RE = /\[[^\]]+\]\(\.\/[^)]+\)/g;
const FRONTMATTER_DESC_RE = /^description:\s*(.+)$/m;
const DESCRIPTION_MAX = 160;

type Section = { heading: string; terms: string[] };

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// Mirrors GitHub's heading slugger: lowercase, strip punctuation (keeping hyphens),
// then replace spaces with hyphens. "Section 1 — Foundations" → "section-1--foundations".
// Persian-safe: keeps \p{L} letters, drops zero-width chars (ZWNJ/ZWJ) and normalizes
// Arabic yeh/kaf variants to Persian so anchors stay stable across editors.
function headingSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/\u064A/g, "\u06CC")
    .replace(/\u0643/g, "\u06A9")
    .replace(/[\u200C\u200D\u200E\u200F\u00AD]/g, "")
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");
}

function parseCurriculum(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  text.split("\n").forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.trimEnd();
    if (line === "") return;

    if (line.startsWith("## ")) {
      if (!SECTION_RE.test(line)) {
        fail(
          `Curriculum.md:${lineNo}: section heading must match "## Section N — Title" (em-dash required): ${line}`
        );
      }
      current = { heading: line.slice(3), terms: [] };
      sections.push(current);
      return;
    }

    if (line.startsWith("- ")) {
      if (!current)
        fail(`Curriculum.md:${lineNo}: bullet before any section heading`);
      const m = line.match(BULLET_RE);
      if (!m || !m[1])
        fail(`Curriculum.md:${lineNo}: malformed bullet: ${line}`);
      const term = m[1];
      if (term.trim() !== term)
        fail(`Curriculum.md:${lineNo}: term has surrounding whitespace`);
      if (/[*_`\[]/.test(term))
        fail(
          `Curriculum.md:${lineNo}: term must be plain text, no markdown: ${term}`
        );
      current.terms.push(term);
      return;
    }

    fail(
      `Curriculum.md:${lineNo}: only "## Section N — Title" headings and "- Term" bullets are allowed: ${line}`
    );
  });

  return sections;
}

// Extracts frontmatter metadata and the body. Fails loudly on an unterminated
// frontmatter block so a malformed entry is caught at build time instead of
// silently emitting a truncated body (data loss).
function parseFrontmatter(
  body: string,
  term: string
): { description?: string; rest: string } {
  if (!body.startsWith("---\n")) return { rest: body };
  const end = body.indexOf("\n---\n", 4);
  if (end === -1)
    fail(`${term}.md: unterminated frontmatter (no closing "---" line)`);
  const frontmatter = body.slice(4, end);
  const descMatch = frontmatter.match(FRONTMATTER_DESC_RE);
  return {
    description: descMatch?.[1]?.trim(),
    rest: body.slice(end + 5).replace(/^\n+/, ""),
  };
}

function rewriteLinks(body: string): string {
  return body.replace(LINK_RE, (_, text: string, target: string) => {
    return `[${text}](#${headingSlug(decodeURIComponent(target))})`;
  });
}

// Every [text](./Target.md) must resolve to a real entry file, and any relative
// link that is not an entry link (no .md) is an error — such links would break
// in the generated README instead of rewriting to an anchor.
function validateLinks(term: string, body: string, onDisk: Set<string>): void {
  for (const m of body.matchAll(ANY_RELATIVE_LINK_RE)) {
    const raw = m[0];
    if (!/\.md\)$/.test(raw))
      fail(
        `${term}.md: relative link "${raw}" does not end in .md — use [text](./Entry.md) form`
      );
    const target = decodeURIComponent(
      raw.match(/\.\/([^)]+)\.md\)/)?.[1] ?? ""
    );
    if (!onDisk.has(target))
      fail(`${term}.md: links to "./${target}.md" which does not exist`);
  }
}

function main(): void {
  const template = readFileSync(TEMPLATE, "utf8");
  if (!template.includes(MARKER)) fail(`Template missing ${MARKER} marker`);
  if (!template.includes(TOC_MARKER))
    fail(`Template missing ${TOC_MARKER} marker`);

  const sections = parseCurriculum(readFileSync(CURRICULUM, "utf8"));

  const onDisk = new Set(
    readdirSync(DICT_DIR)
      .filter((n) => n.endsWith(".md"))
      .map((n) => n.slice(0, -3))
  );

  const seen = new Set<string>();
  const parts: string[] = [];
  for (const section of sections) {
    parts.push(`## ${section.heading}`, "");
    for (const term of section.terms) {
      if (seen.has(term)) fail(`Curriculum.md: duplicate term "${term}"`);
      seen.add(term);
      const entryPath = join(DICT_DIR, `${term}.md`);
      let body: string;
      try {
        body = readFileSync(entryPath, "utf8");
      } catch {
        fail(
          `Curriculum.md references "${term}" but ${entryPath} does not exist`
        );
      }
      const { description, rest } = parseFrontmatter(body, term);
      if (description === undefined)
        fail(`${term}.md: missing frontmatter "description" field`);
      if (description.length > DESCRIPTION_MAX)
        fail(
          `${term}.md: description is ${description.length} chars, max ${DESCRIPTION_MAX}: ${description}`
        );
      validateLinks(term, rest, onDisk);
      parts.push(`### ${term}`, "", rewriteLinks(rest.trimEnd()), "");
    }
  }

  const orphans = [...onDisk].filter((t) => !seen.has(t)).sort();
  if (orphans.length)
    fail(
      `dictionary/ entries not referenced by Curriculum.md: ${orphans.join(", ")}`
    );

  const block = parts.join("\n").trimEnd() + "\n";
  const toc = sections
    .map((s) => {
      const terms = s.terms
        .map((t) => `- [${t}](#${headingSlug(t)})`)
        .join("\n");
      return [
        "<details>",
        `<summary>${s.heading}</summary>`,
        "",
        terms,
        "",
        "</details>",
      ].join("\n");
    })
    .join("\n\n");
  const banner =
    "<!--\n" +
    "  GENERATED FILE — DO NOT EDIT.\n" +
    "  Source: dictionary/*.md, internal/Curriculum.md, internal/README.template.md\n" +
    "  Regenerate: npm run generate\n" +
    "-->\n\n";
  writeFileSync(
    OUTPUT,
    banner + template.replace(TOC_MARKER, toc).replace(MARKER, block)
  );
}

main();
