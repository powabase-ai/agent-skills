import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";

// Offline structural sanity checks for every skill in this repo. These run with
// no network access so CI is deterministic: they validate the Agent Skills
// frontmatter contract, reference-link integrity, and the plugin marketplace
// manifest. (An `npx skills add` install smoke test can be layered on later.)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(ROOT, "skills");

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/; // lowercase, no leading/trailing/double hyphen
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function discoverSkillNames(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => existsSync(join(SKILLS_DIR, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

const skillNames = discoverSkillNames();

describe("skills repository", () => {
  it("contains at least one skill", () => {
    expect(skillNames.length).toBeGreaterThan(0);
    console.log(`Discovered ${skillNames.length} skill(s): ${skillNames.join(", ")}`);
  });
});

describe.each(skillNames)("skill: %s", (skillName) => {
  const skillDir = join(SKILLS_DIR, skillName);
  const skillMd = join(skillDir, "SKILL.md");
  const { data, content } = matter(readFileSync(skillMd, "utf8"));

  it("has a valid `name` matching the directory", () => {
    expect(typeof data.name).toBe("string");
    expect(data.name).toBe(skillName);
    expect(data.name).toMatch(NAME_RE);
    expect(data.name.length).toBeLessThanOrEqual(64);
  });

  it("has a non-empty `description` within 1024 chars", () => {
    expect(typeof data.description).toBe("string");
    expect(data.description.trim().length).toBeGreaterThan(0);
    expect(data.description.length).toBeLessThanOrEqual(1024);
  });

  it("has a semver `metadata.version`", () => {
    expect(data.metadata).toBeTypeOf("object");
    expect(typeof data.metadata.version).toBe("string");
    expect(data.metadata.version).toMatch(SEMVER_RE);
  });

  it("links every references/ file from SKILL.md and vice versa", () => {
    const refsDir = join(skillDir, "references");
    if (!existsSync(refsDir)) return;

    const refFiles = readdirSync(refsDir).filter((f) => f.endsWith(".md")).sort();
    const linked = new Set(
      [...content.matchAll(/references\/([A-Za-z0-9._-]+\.md)/g)].map((m) => m[1])
    );

    // every reference file is linked from SKILL.md
    for (const file of refFiles) {
      expect(linked.has(file), `references/${file} is not linked from SKILL.md`).toBe(true);
    }
    // every link in SKILL.md points to a real file
    for (const ref of linked) {
      expect(
        existsSync(join(refsDir, ref)),
        `SKILL.md links references/${ref} which does not exist`
      ).toBe(true);
    }
  });
});

describe("plugin marketplace manifest", () => {
  const manifestPath = join(ROOT, ".claude-plugin", "marketplace.json");

  it("is valid JSON and references existing skills", () => {
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(Array.isArray(manifest.plugins)).toBe(true);
    for (const plugin of manifest.plugins) {
      for (const skillPath of plugin.skills ?? []) {
        const resolved = join(ROOT, skillPath, "SKILL.md");
        expect(existsSync(resolved), `${skillPath}/SKILL.md missing`).toBe(true);
      }
    }
  });
});

describe("gemini-extension.json (Gemini CLI manifest)", () => {
  const manifestPath = join(ROOT, "gemini-extension.json");

  it("is valid JSON with name, semver version, and a description", () => {
    expect(existsSync(manifestPath)).toBe(true);
    const ext = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(ext.name).toMatch(NAME_RE);
    expect(ext.version).toMatch(SEMVER_RE);
    expect(typeof ext.description).toBe("string");
    expect(ext.description.trim().length).toBeGreaterThan(0);
  });
});

describe.each(skillNames)("Codex metadata: %s", (skillName) => {
  const openaiYaml = join(SKILLS_DIR, skillName, "agents", "openai.yaml");

  it("agents/openai.yaml is well-formed if present", () => {
    if (!existsSync(openaiYaml)) return; // optional file
    const text = readFileSync(openaiYaml, "utf8");
    expect(text.trim().length).toBeGreaterThan(0);
    // Lightweight structural check (no YAML dependency).
    expect(text, "expected an `interface:` block").toMatch(/^interface:/m);
    expect(text, "expected a `policy:` block").toMatch(/^policy:/m);
  });
});
