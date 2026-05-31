import { readConfig } from './config.js';
import { createClipboardHubServer } from './server.js';

const config = readConfig();
const hub = await createClipboardHubServer(config);
await hub.listen();

const address = hub.address();
console.log(`clipboard-hub listening on ${address.address}:${address.port}`);

async function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  await hub.close();
}

process.once('SIGINT', () => {
  shutdown('SIGINT').then(() => process.exit(0));
});

process.once('SIGTERM', () => {
  shutdown('SIGTERM').then(() => process.exit(0));
});

