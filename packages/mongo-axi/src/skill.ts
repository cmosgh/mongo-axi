import { createSkillMarkdown } from "../../core/src/skill.js";
import { DESCRIPTION } from "./cli.js";

export const skillMarkdown = (): string =>
  createSkillMarkdown({
    name: "mongo-axi",
    trigger:
      "Read-only MongoDB access through the mongo-axi CLI - list databases and collections, infer a collection's fields and types, list indexes, sample documents, run capped find/aggregate/count/distinct/explain. " +
      "Use whenever a task needs to look at data or schema in a MongoDB database. It cannot change data.",
    description: DESCRIPTION,
  });
