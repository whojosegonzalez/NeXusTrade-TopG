import { parseDashboardExportArgs } from "../research-dashboard/DashboardExportConfig.js";
import {
  DashboardExportService,
  formatDashboardExportSummary,
} from "../research-dashboard/DashboardExportService.js";

const config = parseDashboardExportArgs(process.argv.slice(2));
const result = new DashboardExportService({ config }).write();
console.log(formatDashboardExportSummary(result));
