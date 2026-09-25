import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ActiveSessionTelemetry,
  SessionControlCommand,
  SessionControlAction,
} from "@nexustrade/shared";

export interface SessionControlIpcServiceOptions {
  readonly tmpDir?: string;
  readonly activeStateFileName?: string;
  readonly commandFileName?: string;
}

export class SessionControlIpcService {
  private readonly tmpDir: string;
  private readonly activeStateFilePath: string;
  private readonly commandFilePath: string;

  constructor(options: SessionControlIpcServiceOptions = {}) {
    this.tmpDir = options.tmpDir ?? path.resolve(process.cwd(), ".tmp");
    this.activeStateFilePath = path.join(
      this.tmpDir,
      options.activeStateFileName ?? "paper-session-active.json",
    );
    this.commandFilePath = path.join(
      this.tmpDir,
      options.commandFileName ?? "session-commands.json",
    );

    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }
  }

  dispatchCommand(action: SessionControlAction, targetPositionId?: string): SessionControlCommand {
    this.ensureTmpDir();
    const cmd: SessionControlCommand = {
      action,
      ...(targetPositionId ? { targetPositionId } : {}),
      issuedAt: Date.now(),
    };

    const existing = this.readCommandQueue();
    existing.push(cmd);
    fs.writeFileSync(this.commandFilePath, JSON.stringify(existing, null, 2), "utf8");
    return cmd;
  }

  pollNextCommand(): SessionControlCommand | null {
    this.ensureTmpDir();
    const queue = this.readCommandQueue();
    if (queue.length === 0) return null;

    const next = queue.shift()!;
    fs.writeFileSync(this.commandFilePath, JSON.stringify(queue, null, 2), "utf8");
    return next;
  }

  writeActiveSessionState(state: ActiveSessionTelemetry): void {
    this.ensureTmpDir();
    const tempFile = `${this.activeStateFilePath}.tmp-${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tempFile, this.activeStateFilePath);
  }

  private ensureTmpDir(): void {
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }
  }

  readActiveSessionState(): ActiveSessionTelemetry | null {
    if (!fs.existsSync(this.activeStateFilePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(this.activeStateFilePath, "utf8");
      return JSON.parse(raw) as ActiveSessionTelemetry;
    } catch {
      return null;
    }
  }

  clear(): void {
    if (fs.existsSync(this.commandFilePath)) {
      fs.unlinkSync(this.commandFilePath);
    }
    if (fs.existsSync(this.activeStateFilePath)) {
      fs.unlinkSync(this.activeStateFilePath);
    }
  }

  private readCommandQueue(): SessionControlCommand[] {
    if (!fs.existsSync(this.commandFilePath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(this.commandFilePath, "utf8");
      const parsed = JSON.parse(raw) as SessionControlCommand[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
