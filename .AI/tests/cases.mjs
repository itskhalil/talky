import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(__dirname, "..", "Examples");

// Exclude cases used as in-prompt examples to avoid biasing scores
const EXCLUDE = [];

export default function () {
  const cases = [];

  for (const dir of readdirSync(EXAMPLES_DIR)) {
    if (EXCLUDE.includes(dir)) continue;
    const exDir = join(EXAMPLES_DIR, dir);
    let files;
    try {
      files = readdirSync(exDir);
    } catch {
      continue;
    }

    const transcriptFile = files.find(
      (f) => f.includes("transcript") && !f.endsWith(".png"),
    );
    const enhancedFile = files.find((f) => f.includes("enhanced"));
    const notesFile = files.find(
      (f) => f.includes(" - notes") && !f.endsWith(".png"),
    );

    if (!transcriptFile || !enhancedFile) continue;

    cases.push({
      description: dir,
      vars: {
        caseLabel: dir,
        transcript: readFileSync(join(exDir, transcriptFile), "utf-8"),
        notes: notesFile ? readFileSync(join(exDir, notesFile), "utf-8") : "",
        golden: readFileSync(join(exDir, enhancedFile), "utf-8"),
      },
    });
  }

  return cases;
}
