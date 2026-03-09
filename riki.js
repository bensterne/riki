import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

// Validate required args
const filename = process.argv[2];
if (!filename) {
  console.error("Usage: node riki.js <filename>");
  console.error("Set ANTHROPIC_API_KEY as an environment variable.");
  process.exit(1);
}

// API key is read from env automatically by the SDK — no need to pass it
const client = new Anthropic();
const repoPath = process.cwd();

// Read config
const configPath = path.join(repoPath, ".riki.json");
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : { wikiPage: "Riki Wiki", maxTokens: 2048 };

const wikiPageName = config.wikiPage.replace(/ /g, "-");
const maxTokens = config.maxTokens ?? 2048;

// Safe git wrapper using execFileSync (no shell interpolation)
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function generateAndUpdateWiki() {
  // 1. Read the existing code file
  const filePath = path.join(repoPath, filename);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }
  const code = fs.readFileSync(filePath, "utf8");
  console.log(`📄 Read ${filename}`);

  // 2. Generate docs via Claude
  console.log(`⚙️  Generating docs...`);
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    messages: [{
      role: "user",
      content: `Generate clear documentation for this code file. Do not repeat the filename as a heading.
                Include a description, list of methods/properties, and any important notes.
                Use markdown formatting.
                Do not include the code itself.
                Code:
                ${code}`
    }]
  });

  // Guard against unexpected response shape
  const firstBlock = response.content[0];
  if (!firstBlock || firstBlock.type !== "text") {
    console.error("❌ Unexpected response from Claude API");
    process.exit(1);
  }
  const newDocs = firstBlock.text;

  // 3. Get wiki URL from current repo
  const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const wikiUrl = remoteUrl.replace(/\.git$/, ".wiki.git");

  // 4. Clone wiki into a temp folder, or init if it doesn't exist yet
  const tmpWiki = `/tmp/riki-wiki-${Date.now()}`;
  console.log(`📥 Cloning wiki...`);

  try {
    execFileSync("git", ["clone", wikiUrl, tmpWiki]);
  } catch {
    console.log(`📝 Wiki doesn't exist yet, initializing...`);
    fs.mkdirSync(tmpWiki);
    git(tmpWiki, "init");
    git(tmpWiki, "remote", "add", "origin", wikiUrl);

    const initFile = path.join(tmpWiki, `${wikiPageName}.md`);
    fs.writeFileSync(initFile, "");

    git(tmpWiki, "add", ".");
    git(tmpWiki, "commit", "-m", "riki: initialize wiki");
    git(tmpWiki, "push", "-u", "origin", "master");

    // Clone fresh so the rest of the flow is consistent
    fs.rmSync(tmpWiki, { recursive: true, force: true });
    execFileSync("git", ["clone", wikiUrl, tmpWiki]);
  }

  try {
    // 5. Read or create the wiki page
    const wikiFile = path.join(tmpWiki, `${wikiPageName}.md`);
    let wikiContent = fs.existsSync(wikiFile)
      ? fs.readFileSync(wikiFile, "utf8")
      : "";

    // 6. Build the new section with HTML comment markers
    const timestamp = new Date().toUTCString();
    const BEGIN_MARKER = `<!-- RIKI:BEGIN ${filename} -->`;
    const END_MARKER = `<!-- RIKI:END ${filename} -->`;
    const sectionHeader = `## ${filename}`;
    const newSection = `${BEGIN_MARKER}\n${sectionHeader}\n_Last updated: ${timestamp}_\n\n${newDocs}\n\n---\n${END_MARKER}\n`;

    // 7. Replace existing section (exact match) or append
    if (wikiContent.includes(BEGIN_MARKER)) {
      const before = wikiContent.substring(0, wikiContent.indexOf(BEGIN_MARKER));
      const after = wikiContent.substring(wikiContent.indexOf(END_MARKER) + END_MARKER.length);
      wikiContent = before + newSection + after;
      console.log(`🔄 Updated existing section for ${filename}`);
    } else {
      wikiContent += newSection;
      console.log(`➕ Added new section for ${filename}`);
    }

    // 8. Write, commit, push
    fs.writeFileSync(wikiFile, wikiContent);
    git(tmpWiki, "add", `${wikiPageName}.md`);
    git(tmpWiki, "commit", "-m", `riki: updated docs for ${filename} at ${timestamp}`);
    git(tmpWiki, "push");

    console.log(`✅ Wiki updated!`);
  } finally {
    // Always clean up the temp directory, even on failure
    fs.rmSync(tmpWiki, { recursive: true, force: true });
  }
}

generateAndUpdateWiki().catch((err) => {
  console.error("❌ Fatal error:", err.message);
  process.exit(1);
});