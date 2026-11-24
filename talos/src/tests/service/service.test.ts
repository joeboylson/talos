import { expect, test } from "bun:test";
import { buildLaunchAgentPlist, buildSystemdUnit } from "../../service";

const specOf = (programArguments: string[], environment: Record<string, string> = {}) => ({ programArguments, environment, logFile: "/Users/joe/.talos/talos.log" });
const TALOS = ["/bin/bun", "--env-file=/Users/joe/.talos/talos.env", "/Users/joe/.talos/app/talos/src/index.ts"];

test("the launch agent runs talos at login and again whenever it stops, logging to talos's folder", () => {
  const plist = buildLaunchAgentPlist(specOf(TALOS, { PATH: "/opt/homebrew/bin:/usr/bin" }));
  expect(plist).toContain("<key>Label</key><string>local.talos</string>");
  expect(plist).toContain(`<key>ProgramArguments</key><array>${TALOS.map((word) => `<string>${word}</string>`).join("")}</array>`);
  expect(plist).toContain("<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string></dict>");
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(plist).toContain("<key>KeepAlive</key><true/>");
  expect(plist).toContain("<key>StandardErrorPath</key><string>/Users/joe/.talos/talos.log</string>");
});

// A folder named with & or < (this repo lives under "@") stays one argument.
test("a launch agent path with characters XML treats specially reads back as it was", () => {
  const plist = buildLaunchAgentPlist(specOf(["/Users/joe/a & b/<x>/index.ts"]));
  expect(plist).toContain("<string>/Users/joe/a &amp; b/&lt;x&gt;/index.ts</string>");
  const parsed = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", "-"], { stdin: new TextEncoder().encode(plist) });
  if (parsed.exitCode === 0) expect(JSON.parse(parsed.stdout.toString()).ProgramArguments).toEqual(["/Users/joe/a & b/<x>/index.ts"]);
});

test("the systemd unit runs talos at login and again whenever it stops, logging to talos's folder", () => {
  const unit = buildSystemdUnit(specOf(TALOS, { PATH: "/usr/local/bin:/usr/bin" }));
  expect(unit).toContain(`ExecStart=${TALOS.map((word) => `"${word}"`).join(" ")}`);
  expect(unit).toContain('Environment="PATH=/usr/local/bin:/usr/bin"');
  expect(unit).toContain("Restart=always");
  expect(unit).toContain("StandardOutput=append:/Users/joe/.talos/talos.log");
  expect(unit).toContain("WantedBy=default.target");
});

// systemd would read % as the start of one of its specifiers, and a quote or
// backslash as the end of the word.
test("a systemd path with spaces, quotes or % stays one word, as it was", () => {
  expect(buildSystemdUnit(specOf(['/home/joe/my "code"/100%/index.ts']))).toContain('ExecStart="/home/joe/my \\"code\\"/100%%/index.ts"');
});
