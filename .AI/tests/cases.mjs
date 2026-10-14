import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(__dirname, "..", "Examples");

// Exclude cases used as in-prompt examples to avoid biasing scores
const EXCLUDE = [];

// A golden that was never written scores ~0.2 for every model and silently drags
// down any full-set average. Detected by content rather than by name, so a case
// rejoins the set automatically once its golden is filled in.
const isPlaceholderGolden = (text) => text.trim().length < 50;

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

    const golden = readFileSync(join(exDir, enhancedFile), "utf-8");
    if (isPlaceholderGolden(golden)) {
      console.warn(
        `[cases] skipping ${dir}: golden reference is a placeholder`,
      );
      continue;
    }

    cases.push({
      description: dir,
      vars: {
        caseLabel: dir,
        transcript: readFileSync(join(exDir, transcriptFile), "utf-8"),
        notes: notesFile ? readFileSync(join(exDir, notesFile), "utf-8") : "",
        golden,
      },
    });
  }

  return cases;
}
