# NeXusTrade-TopG
Solana Trading Bot

## Command to Reset DB (Clear all data & apply new schema):

```bash
npx prisma migrate reset
```

## How can I view our data?
The best way is Prisma Studio, a visual GUI for your database.

```bash
npx prisma studio
```
This will open a tab in your browser (usually at http://localhost:5555)

## How many tables are we using?

### Currently (after the update): 6 Tables
- Session: Tracks the overall run (Balance, Profit).
- TokenRadar: Tracks every token the scanner found.
- Trade: Tracks every buy/sell execution.
- SystemLog: (New) For debugging logs.
- PLSnapshot: (New) For equity curves.
- _prisma_migrations: (Internal) Tracks schema changes.