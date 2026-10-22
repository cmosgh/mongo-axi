// Hard cap so a regeneration cannot re-inflate the stub with CLI-owned guidance.
export const MAX_SKILL_MARKDOWN_CHARS = 2400;

export interface SkillSpec {
  name: string;
  /** Trigger string agents match against to auto-load the skill. */
  trigger: string;
  description: string;
  /** Extra paragraph right under the title (the write tool's warning). */
  notice?: string;
}

/** A discovery stub, not a copy of the CLI's guidance: `<cli> --help` never goes stale. */
export function createSkillMarkdown(spec: SkillSpec): string {
  const markdown = `---
name: ${spec.name}
description: ${JSON.stringify(spec.trigger)}
user-invocable: false
---

# ${spec.name}
${spec.notice ? `\n${spec.notice}\n` : ""}
${spec.description}

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- \`npx -y ${spec.name}\` for an overview and the configured connections
- \`npx -y ${spec.name} --help\` for the command index
- \`npx -y ${spec.name} <command> --help\` for per-command flags and examples

Connecting is a one-time, user-performed step: \`printf %s "$DB_PASSWORD" | npx -y ${spec.name} auth login --profile <name> --uri 'mongodb://<user>@<host>:27017/?authSource=admin' --password-stdin\`. Never ask for the password in chat or pass it as an argument.
`;
  if (markdown.length > MAX_SKILL_MARKDOWN_CHARS) {
    throw new Error(`generated SKILL.md for ${spec.name} is ${markdown.length} chars; keep it under ${MAX_SKILL_MARKDOWN_CHARS}`);
  }
  return markdown;
}
