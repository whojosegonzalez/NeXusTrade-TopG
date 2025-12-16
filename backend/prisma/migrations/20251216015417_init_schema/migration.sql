-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startTime" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" DATETIME,
    "status" TEXT NOT NULL,
    "targetProfit" REAL NOT NULL,
    "stopLoss" REAL NOT NULL,
    "startBalance" REAL NOT NULL,
    "currentBalance" REAL NOT NULL
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "buyPrice" REAL NOT NULL,
    "buyAmount" REAL NOT NULL,
    "buyCostSOL" REAL NOT NULL,
    "buyTxHash" TEXT,
    "buyTimestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sellPrice" REAL,
    "sellAmount" REAL,
    "sellValueSOL" REAL,
    "sellTxHash" TEXT,
    "sellTimestamp" DATETIME,
    "status" TEXT NOT NULL,
    "pnlSOL" REAL,
    "pnlPercent" REAL,
    CONSTRAINT "Trade_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TokenRadar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mint" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liquidityUSD" REAL NOT NULL,
    "volume24h" REAL NOT NULL,
    "riskScore" INTEGER NOT NULL,
    "decision" TEXT NOT NULL,
    "rejectReason" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "TokenRadar_mint_key" ON "TokenRadar"("mint");
