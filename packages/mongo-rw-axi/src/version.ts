// Leaf module: node builtins only. The `--version` fast path imports it.
import { readPackageVersion } from "../../core/src/version.js";

export const VERSION = readPackageVersion("mongo-rw-axi", import.meta.url);
