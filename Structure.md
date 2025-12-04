# NeXusTrade Project Structure & Inventory

## Status: Phase 1 - Initialization

| File Path | Purpose | Key Parameters/Exports | Status | Tested? |
| :--- | :--- | :--- | :--- | :--- |
| `src/index.ts` | Main Entry Point | `main()` | 🚧 Pending | ❌ |
| `src/config/config.ts` | Central Config Hub | `HELIUS_API_KEY`, `DB_PATH` | 🚧 Pending | ❌ |
| `prisma/schema.prisma` | DB Schema Definition | `Session`, `Trade`, `TokenRadar` | 🚧 Pending | ❌ |
| `tsconfig.json` | TS Compiler Settings | `strict: true` | ✅ Complete | N/A |

---
## Notes
- **Twin Engine**: System is designed to switch DBs based on runtime flags.
- **Local-First**: Using SQLite (WAL mode).