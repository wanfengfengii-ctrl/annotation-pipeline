// Formatting for question prose only; never rewrite native transcripts or code.
export function formatQuestionText(text) {
  return String(text ?? '')
    .replaceAll('`', '')
    .replace(/\r\n?|\u2028|\u2029/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}
