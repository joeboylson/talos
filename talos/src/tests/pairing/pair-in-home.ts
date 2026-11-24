// Pairs with the server given, in the TALOS_HOME this was started with, and
// prints the key it gets. A test starts it, and may stop it mid-wait.
import { pairMachine } from "../../pairing";

const serverOrigin = process.argv[2] ?? "";
const log = { event: (message: string) => console.log(message), detail: () => {}, warn: (message: string) => console.log(message) };
const paired = await pairMachine(serverOrigin, "laptop", log as never);
console.log(`KEY ${paired.machineKey}`);
