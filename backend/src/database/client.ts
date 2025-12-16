import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { CONFIG } from '../config';
import path from 'node:path';
import fs from 'node:fs';

const getDatabasePath = () => {
    const dbFileName = CONFIG.SIMULATION_MODE ? 'nexus_sim.db' : 'nexus_live.db';
    
    // Ensure the prisma directory exists (Adapter won't create folders for us)
    const prismaDir = path.resolve(__dirname, '../../prisma');
    if (!fs.existsSync(prismaDir)) {
        fs.mkdirSync(prismaDir, { recursive: true });
    }
    
    return path.join(prismaDir, dbFileName);
};

const dbPath = getDatabasePath();

console.log(`🔌 Database Factory: Connecting to [ ${CONFIG.SIMULATION_MODE ? '🟢 SIMULATION' : '🔴 LIVE'} ] Database...`);
console.log(`📂 Path: ${dbPath}`);

// --- PRISMA 7 FIX ---
// The adapter is now a Factory. We pass the configuration object, 
// and it instantiates the underlying driver internally.
// We prefix with 'file:' because the adapter expects a Connection URL, not just a path.
const adapter = new PrismaBetterSqlite3({
    url: `file:${dbPath}`,
    // better-sqlite3 options (like timeout, readonly) can be passed here if needed
});

export const prisma = new PrismaClient({
    adapter,
});