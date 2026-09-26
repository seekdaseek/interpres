/**
 * Entry point for process managers.
 *
 * PM2's fork mode runs `node <pm2>/lib/ProcessContainerFork.js` and imports the
 * script from there, so `process.argv[1]` is PM2's file and index.ts's isMain
 * guard never fires. Measured through PM2 7.0.1's own container: index.ts
 * imported, printed nothing and exited 0, which PM2 restarts forever.
 */
import { start } from './index.ts';

start();
