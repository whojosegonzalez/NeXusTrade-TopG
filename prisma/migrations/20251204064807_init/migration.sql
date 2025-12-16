-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "strategy" TEXT NOT NULL,
    "isSimulation" BOOLEAN NOT NULL,
    "startBalance" REAL NOT NULL,
    "currentBalance" REAL NOT NULL,
    "targetProfit" REAL NOT NULL,
    "stopLoss" REAL NOT NULL,
    "status" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "buyTimestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "buyPrice" REAL NOT NULL,
    "buyAmount" REAL NOT NULL,
    "buyCostSol" REAL NOT NULL,
    "buyTxHash" TEXT,
    "sellTimestamp" DATETIME,
    "sellPrice" REAL,
    "sellValueSol" REAL,
    "sellTxHash" TEXT,
    "status" TEXT NOT NULL,
    "pnlSol" REAL,
    "pnlPercent" REAL,
    "feesPaid" REAL,
    CONSTRAINT "Trade_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TokenRadar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mint" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "liquidityUsd" REAL NOT NULL,
    "volume24h" REAL NOT NULL,
    "riskScore" INTEGER NOT NULL,
    "decision" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" TEXT,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" TEXT,
    CONSTRAINT "SystemLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TokenRadar_mint_key" ON "TokenRadar"("mint");
