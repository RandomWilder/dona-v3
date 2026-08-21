// PreToolUse guard: blocks obviously destructive shell commands. Exit 2 = block.
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let command = '';
try {
  command = JSON.parse(raw)?.tool_input?.command ?? '';
} catch {
  process.exit(0);
}
const deny = [
  [/\brm\s+(-[a-z]*f[a-z]*\s+)+\/(\s|$)/i, 'rm -rf on filesystem root'],
  [/\bgit\s+push\b.*(--force|-f)\b/i, 'force push (use --force-with-lease deliberately, outside hooks)'],
  [/\bpsql\b.*prod/i, 'raw psql against a prod database'],
  [/\bgcloud\b.*\b(delete|destroy)\b/i, 'destructive gcloud command'],
  [/\bdrop\s+(database|schema)\b/i, 'DROP DATABASE/SCHEMA'],
];
for (const [re, why] of deny) {
  if (re.test(command)) {
    console.error(`Blocked by guard-bash hook: ${why}. Run it manually if truly intended.`);
    process.exit(2);
  }
}
process.exit(0);
