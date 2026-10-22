import { readConfig } from "../config.js";
import { block, helpBlock, out, type Obj } from "../render.js";
import { describeTarget, isConfigured, loginHint, profileTarget, selectedProfile, targetFromUri, URI_SHAPE } from "../target.js";
import { env, tool } from "../tool.js";

/**
 * Runs at every agent session start: never touches the network or the
 * keychain, so it stays instant and silent about secrets.
 */
export async function homeCommand(): Promise<string> {
  const name = tool().name;
  const banner = block(tool().banner);
  const urlVar = `${tool().envPrefix}_URL`;
  if (!isConfigured()) {
    return out(banner, block({ status: "not configured" }), helpBlock([loginHint(), `Or set ${urlVar}=${URI_SHAPE.split(" or ")[0]}`]));
  }
  const status: Obj = {};
  const url = env("URL");
  if (url) {
    try {
      status["connection"] = `${describeTarget(targetFromUri(url, urlVar, "env"))} (${urlVar})`;
    } catch {
      status["connection"] = `${urlVar} is set but invalid`;
    }
  }
  const config = readConfig();
  const active = selectedProfile();
  const profiles = Object.entries(config.profiles ?? {}).map(([profile, p]) => {
    let target: string;
    try {
      target = describeTarget(profileTarget(profile, p, undefined));
    } catch {
      target = "invalid connection string";
    }
    return { name: profile, target, active: !url && profile === active };
  });
  return out(
    banner,
    Object.keys(status).length > 0 && block(status),
    profiles.length > 0 && block({ profiles }),
    helpBlock([
      `Run \`${name} collections\`, \`${name} describe <collection>...\`, \`${name} search <name>\` or \`${name} sample <collection>\` to explore`,
      `Run \`${name} find <collection> '{status: "paid"}'\`, \`${name} aggregate <collection> '[...]'\` or \`${name} 'db.<collection>.find({...})'\`; \`${name} <command> --help\` for flags`,
      ...(tool().writeHint ? [tool().writeHint!] : []),
    ]),
  );
}
