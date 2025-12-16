import { PrismaClient } from '@prisma/client';
import path from 'node:path'; // FIXED: Explicit Node import

// Define the two physical paths for our databases
const DB_PATH_LIVE = `file:${path.join(process.cwd(), 'prisma/nexus_live.db')}`;
const DB_PATH_SIM = `file:${path.join(process.cwd(), 'prisma/nexus_sim.db')}`;

let prisma: PrismaClient | null = null;

export const initDatabase = (isSimulation: boolean) => {
    if (prisma) return prisma;

    const dbUrl = isSimulation ? DB_PATH_SIM : DB_PATH_LIVE;
    
    console.log(`\n🔋 Twin Engine: Initializing ${isSimulation ? '🟦 SIMULATION' : '🟥 LIVE'} Database...`);
    console.log(`📂 Target: ${dbUrl}\n`);

    prisma = new PrismaClient({
        datasources: {
            db: {
                url: dbUrl,
            },
        },
    });

    return prisma;
};

export const getDB = () => {
    if (!prisma) {
        throw new Error("Database not initialized! Call initDatabase(isSim) first.");
    }
    return prisma;
};