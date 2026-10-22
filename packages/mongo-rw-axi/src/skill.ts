import { createSkillMarkdown } from "../../core/src/skill.js";
import { DESCRIPTION } from "./cli.js";

export const skillMarkdown = (): string =>
  createSkillMarkdown({
    name: "mongo-rw-axi",
    trigger:
      "WRITE ACCESS to LOCAL MongoDB databases through the mongo-rw-axi CLI - insert, update and delete documents, create and drop indexes and collections, import JSON. " +
      "Use only when a task must change a local dev database; use mongo-axi for reading or for any non-local database.",
    description: DESCRIPTION,
    notice:
      "> **WARNING - this tool can modify and drop data.** It only connects directly to one loopback host or unix socket and refuses tunnels to replica sets whose members are not local. Irreversible operations preview until `--confirm`; read the preview before confirming.",
  });
