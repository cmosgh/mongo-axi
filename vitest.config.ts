import { configDefaults, defineConfig } from "vitest/config";

// test:integration needs Docker; it does not run here.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "test/integration/**"] },
});
