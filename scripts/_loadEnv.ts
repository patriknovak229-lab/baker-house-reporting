// Side-effect module: load .env.local BEFORE any module that reads
// process.env at import time (e.g. lib/db.ts). Import this FIRST in CLI
// scripts — as an import side-effect it runs before sibling imports, which
// a plain `config()` statement does not (bundlers hoist imports above it).
import { config } from 'dotenv';

config({ path: '.env.local' });
