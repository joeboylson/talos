// Opens many idle connections to the hooks socket and holds them, as a hostile
// session could. Used by live.ts; run it from a process with a high file limit.
const [socketPath, countText] = process.argv.slice(2);
const count = Number(countText);
const held: unknown[] = [];
for (let index = 0; index < count; index += 1) {
  held.push(await Bun.connect({ unix: socketPath, socket: { data: () => {}, error: () => {} } }).catch(() => null));
}
await Bun.sleep(60_000);
