#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ $# -eq 0 ]; then
  echo "Usage: $0 <variant-name>"
  echo "Example: $0 denser-bullets"
  exit 1
fi

VARIANT="$1"
VARIANT_DIR="$SCRIPT_DIR/prompt-variants/$VARIANT"
PROMPT_FILE="$SCRIPT_DIR/prompts/$VARIANT.mjs"

if [ -d "$VARIANT_DIR" ]; then
  echo "Error: variant '$VARIANT' already exists at $VARIANT_DIR"
  exit 1
fi

# Copy baseline prompt files (not symlinks — copies for editing)
mkdir -p "$VARIANT_DIR"
cp "$(readlink -f "$SCRIPT_DIR/prompt-variants/baseline/system.txt")" "$VARIANT_DIR/system.txt"
cp "$(readlink -f "$SCRIPT_DIR/prompt-variants/baseline/user.txt")" "$VARIANT_DIR/user.txt"

# Create prompt function
cat > "$PROMPT_FILE" << 'TEMPLATE'
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
TEMPLATE

echo "const VARIANT_DIR = join(__dirname, '..', 'prompt-variants', '$VARIANT');" >> "$PROMPT_FILE"

cat >> "$PROMPT_FILE" << 'TEMPLATE'

export default async function ({ vars }) {
  const systemPrompt = readFileSync(join(VARIANT_DIR, 'system.txt'), 'utf-8');
  const userTemplate = readFileSync(join(VARIANT_DIR, 'user.txt'), 'utf-8');

  const notesSection = vars.notes?.trim() ? vars.notes : 'No notes were taken.';
  const userMessage = `<user_notes>\n${notesSection}\n</user_notes>\n\n<transcript>\n${vars.transcript}\n</transcript>\n\n${userTemplate}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
}
TEMPLATE

echo ""
echo "Created variant '$VARIANT':"
echo "  Prompts: $VARIANT_DIR/"
echo "  Function: $PROMPT_FILE"
echo ""
echo "Next steps:"
echo "  1. Edit the prompt files:"
echo "     \$EDITOR $VARIANT_DIR/system.txt"
echo "     \$EDITOR $VARIANT_DIR/user.txt"
echo "  2. Add to .AI/promptfooconfig.yaml under 'prompts:':"
echo "     - id: file://prompts/$VARIANT.mjs"
echo "       label: $VARIANT"
echo "  3. Run: npm run eval"
