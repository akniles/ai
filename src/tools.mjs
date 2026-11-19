import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function stopTree(child) {
  if (process.platform === "win32")
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}
export class Tools {
  constructor(client, workspace) {
    Object.assign(this, { client, workspace });
    this.jobs = new Map();
    this.runSubagent = null;
  }
  async update(job) {
    await this.client
      .withContext({ ...job.context, spanId: job.executionId })
      .action("operation", {
        id: job.id,
        status: job.status,
        startedAt: job.startedAt,
        data: { kind: job.kind, output: job.output, exitCode: job.exitCode },
      })
      .catch((error) =>
        console.error(`Operation update failed: ${error.message}`),
      );
  }
  newJob(kind, client) {
    if (this.jobs.size >= 100) {
      const old = [...this.jobs.values()].find((j) => j.status !== "running");
      if (old) this.jobs.delete(old.id);
    }
    if (
      [...this.jobs.values()].filter((j) => j.status === "running").length >= 4
    )
      throw new Error("Four concurrent jobs maximum");
    const job = {
      id: randomUUID(),
      executionId: randomBytes(8).toString("hex"),
      kind,
      status: "running",
      output: "",
      startedAt: Date.now(),
      context: client.context,
    };
    this.jobs.set(job.id, job);
    return job;
  }
  async execute(name, a = {}, depth = 0, sessionClient = this.client) {
    await this.client.request("/runtime/context");
    const start = Date.now();
    const traced = sessionClient.withContext({
      spanId: randomBytes(8).toString("hex"),
    });
    const child = traced.withContext({
      spanId: undefined,
      parentSpanId: traced.context.spanId,
    });
    let output;
    try {
      output = await this.executeInner(name, a, depth, child);
      return output;
    } catch (error) {
      output = { error: error.message };
      throw error;
    } finally {
      await traced.observe("tool." + name, a, output, start);
    }
  }
  async executeInner(name, a = {}, depth = 0, sessionClient = this.client) {
    switch (name) {
      case "shell_start": {
        if (typeof a.command !== "string" || a.command.length > 20000)
          throw new Error("Invalid command");
        const job = this.newJob("shell", sessionClient);
        const child = spawn(a.command, {
          cwd: this.workspace,
          shell: true,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        job.child = child;
        const append = (b) => {
          job.output = (
            job.output +
            b
              .toString()
              .replaceAll(this.client.token, "[runtime credential redacted]")
          ).slice(-16000);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const duration = Number(a.timeout_seconds ?? 120);
        if (!Number.isFinite(duration) || duration <= 0) {
          stopTree(child);
          throw new Error("Invalid timeout");
        }
        const timer = setTimeout(
          () => {
            job.status = "timed_out";
            stopTree(child);
          },
          Math.min(duration, 3600) * 1000,
        );
        child.on("error", (e) => {
          job.output = e.message;
          job.status = "failed";
          clearTimeout(timer);
          this.update(job);
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          job.exitCode = code;
          job.signal = signal;
          if (job.status === "running")
            job.status = code === 0 ? "done" : "failed";
          this.update(job);
        });
        await this.update(job);
        return { id: job.id, status: job.status };
      }
      case "job_poll": {
        const j = this.jobs.get(a.id);
        if (!j)
          throw new Error(
            "Operation not found in this worker; check persisted interrupted operations after restart",
          );
        const {
          child,
          promise,
          abort,
          context,
          startedAt,
          executionId,
          ...view
        } = j;
        return view;
      }
      case "job_cancel": {
        const j = this.jobs.get(a.id);
        if (!j) throw new Error("Operation not found");
        j.status = "cancelled";
        if (j.child) stopTree(j.child);
        j.abort?.abort();
        await this.update(j);
        return { ok: true };
      }
      case "skills_list":
        return readdir(join(this.workspace, "skills")).catch(() => []);
      case "skill_read":
      case "skill_write": {
        if (!/^[a-z0-9_-]{1,64}$/.test(a.name))
          throw new Error("Invalid skill name");
        const dir = join(this.workspace, "skills", a.name);
        await mkdir(dir, { recursive: true });
        const path = join(dir, "SKILL.md");
        if (name === "skill_read")
          return (await readFile(path, "utf8")).slice(0, 32000);
        if (typeof a.content !== "string" || a.content.length > 32000)
          throw new Error("Invalid skill");
        await writeFile(path, a.content);
        return { ok: true };
      }
      case "subagent_start": {
        if (depth > 0) throw new Error("Subagent recursion disabled");
        if (typeof a.task !== "string" || a.task.length > 4000)
          throw new Error("Invalid task");
        const j = this.newJob("subagent", sessionClient);
        j.abort = new AbortController();
        j.promise = this.runSubagent(a.task, j.abort.signal, sessionClient)
          .then((r) => {
            j.output = (typeof r === "string" ? r : JSON.stringify(r)).slice(
              -16000,
            );
            if (j.status === "running") j.status = "done";
          })
          .catch((e) => {
            j.output = e.message;
            if (j.status === "running") j.status = "failed";
          })
          .finally(() => this.update(j));
        await this.update(j);
        return { id: j.id, status: j.status };
      }
      default:
        return sessionClient.action(name, a);
    }
  }
  stop() {
    for (const j of this.jobs.values()) {
      if (j.child) stopTree(j.child);
      j.abort?.abort();
    }
  }
}
