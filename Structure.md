# NeXusTrade Project Structure & Inventory

## Status: Phase 1 - Initialization

| File Path | Purpose | Key Parameters/Exports | Status | Tested? |
| :--- | :--- | :--- | :--- | :--- |
| `src/index.ts` | Main Entry Point | `main()` | 🚧 Pending | ❌ |
| `src/config/config.ts` | Central Config Hub | `HELIUS_API_KEY`, `DB_PATH` | 🚧 Pending | ❌ |
| `tsconfig.json` | TS Compiler Settings | `strict: true` | ✅ Complete | N/A |
| `prisma/schema.prisma` | DB Schema | `Session`, `Trade` | ✅ Complete | ⏳ In Progress |
| `src/database/client.ts`| Twin Engine Factory | `initDatabase(isSim)` | ✅ Complete | ⏳ In Progress |
---
## Notes
- **Twin Engine**: System is designed to switch DBs based on runtime flags.
- **Local-First**: Using SQLite (WAL mode).