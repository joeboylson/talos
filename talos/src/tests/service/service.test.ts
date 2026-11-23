import { expect, test } from "bun:test";
import { buildLaunchAgentPlist } from "../../service";

const plistOf = (programArguments: string[], environment: Record<string, string> = {}) =>
  buildLaunchAgentPlist({ label: "local.talos", programArguments, environment, logFile: "/Users/joe/.talos/talos.log" });

test("the launch agent runs talos at login and again whenever it stops, logging to talos's folder", () => {
  const plist = plistOf(["/bin/bun", "--env-file=/Users/joe/.talos/talos.env", "/Users/joe/.talos/app/talos/src/index.ts"], { PATH: "/opt/homebrew/bin:/usr/bin" });
  expect(plist).toContain("<key>Label</key><string>local.talos</string>");
  expect(plist).toContain(
    "<key>ProgramArguments</key><array><string>/bin/bun</string><string>--env-file=/Users/joe/.talos/talos.env</string><string>/Users/joe/.talos/app/talos/src/index.ts</string></array>",
  );
  expect(plist).toContain("<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string></dict>");
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(plist).toContain("<key>KeepAlive</key><true/>");
  expect(plist).toContain("<key>StandardErrorPath</key><string>/Users/joe/.talos/talos.log</string>");
});

// A folder named with & or < (this repo lives under "@") stays one argument.
test("a path with characters XML treats specially is written so it reads back as it was", () => {
  const plist = plistOf(["/Users/joe/a & b/<x>/index.ts"]);
  expect(plist).toContain("<string>/Users/joe/a &amp; b/&lt;x&gt;/index.ts</string>");
  const parsed = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", "-"], { stdin: new TextEncoder().encode(plist) });
  if (parsed.exitCode === 0) expect(JSON.parse(parsed.stdout.toString()).ProgramArguments).toEqual(["/Users/joe/a & b/<x>/index.ts"]);
});
