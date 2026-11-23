// The mod's helper: holds a stream open to the session runner and writes each
// command line it gets to its output, where the mod reads it. It ends when the
// stream does; the runner reads the stream closing as the mod gone.
export {}

const socketPath = process.env.TALOS_LINK_SOCKET ?? ''
const secret = process.env.TALOS_LINK_SECRET ?? ''

const answer = await fetch('http://talos/commands', { unix: socketPath, headers: { authorization: `Bearer ${secret}` } })
if (!answer.ok || !answer.body) process.exit(1)
for await (const chunk of answer.body) process.stdout.write(chunk)
