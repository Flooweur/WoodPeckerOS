// File access for the agent process itself (no executor involved).
//
// The agent runs as an unprivileged user under a read-only view of the
// system, so the kernel already limits it to world-readable files. These
// helpers narrow that further: reads only under a few roots, writes only
// inside the agent's own workspace, and never through a symlink that leads
// out of it.
import fs from "node:fs";
import path from "node:path";

const READ_ROOTS = ["/etc", "/nix/store"];
const MAX_READ = 256 * 1024;
const MAX_WRITE = 1024 * 1024;
const MAX_ENTRIES = 500;

export class FileError extends Error {}

function inside(child: string, root: string): boolean {
  return child === root || child.startsWith(root + path.sep);
}

export class Files {
  private readonly workspace: string;

  constructor(workspaceDir: string) {
    fs.mkdirSync(workspaceDir, { recursive: true });
    this.workspace = fs.realpathSync(workspaceDir);
  }

  get root(): string {
    return this.workspace;
  }

  /** Relative paths are relative to the workspace. */
  private absolute(input: string): string {
    if (input.includes("\0")) throw new FileError("invalid path");
    return path.resolve(this.workspace, input);
  }

  /** Resolves symlinks and checks the real location is somewhere readable. */
  private readable(input: string): string {
    const wanted = this.absolute(input);
    let real: string;
    try {
      real = fs.realpathSync(wanted);
    } catch {
      throw new FileError(`no such file or directory: ${wanted}`);
    }
    const roots = [this.workspace, ...READ_ROOTS];
    if (!roots.some((root) => inside(real, root))) {
      throw new FileError(
        `outside the readable areas (the workspace, ${READ_ROOTS.join(", ")}): ${wanted}`,
      );
    }
    return real;
  }

  list(input: string): { path: string; entries: Array<{ name: string; type: string; size?: number }>; truncated: boolean } {
    const dir = this.readable(input || ".");
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new FileError(`cannot list ${dir}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
    }
    names.sort((a, b) => a.name.localeCompare(b.name));
    const entries = names.slice(0, MAX_ENTRIES).map((entry) => {
      const type = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : entry.isFile() ? "file" : "other";
      let size: number | undefined;
      if (type === "file") {
        try {
          size = fs.statSync(path.join(dir, entry.name)).size;
        } catch {
          /* unreadable: leave size out */
        }
      }
      return { name: entry.name, type, size };
    });
    return { path: dir, entries, truncated: names.length > MAX_ENTRIES };
  }

  read(input: string, offset = 0, maxBytes = 64 * 1024): {
    path: string; size: number; offset: number; bytes: number; truncated: boolean; binary: boolean; content: string;
  } {
    const file = this.readable(input);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      throw new FileError(`cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
    }
    if (!stat.isFile()) throw new FileError(`not a regular file: ${file}`);
    const want = Math.min(Math.max(1, maxBytes), MAX_READ);
    const buffer = Buffer.alloc(Math.min(want, Math.max(0, stat.size - offset)));
    let bytes = 0;
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "r");
      bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
    } catch (err) {
      throw new FileError(`cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    const slice = buffer.subarray(0, bytes);
    const binary = slice.includes(0);
    return {
      path: file,
      size: stat.size,
      offset,
      bytes,
      truncated: offset + bytes < stat.size,
      binary,
      content: binary ? "" : slice.toString("utf8"),
    };
  }

  /**
   * Every regular file below a workspace directory, as {path, content} with
   * paths relative to that directory. Used to send a drafted configuration
   * change to the executor. Symlinks are refused, not followed.
   */
  collect(input: string, maxFiles = 60, maxBytes = 600 * 1024): Array<{ path: string; content: string }> {
    const top = this.readable(input);
    if (!inside(top, this.workspace)) throw new FileError("the directory must be inside the workspace");
    if (!fs.statSync(top).isDirectory()) throw new FileError(`not a directory: ${top}`);
    const out: Array<{ path: string; content: string }> = [];
    let total = 0;
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new FileError(`symlinks cannot be proposed: ${rel}`);
        if (entry.isDirectory()) {
          walk(full, rel);
        } else if (entry.isFile()) {
          const buffer = fs.readFileSync(full);
          if (buffer.includes(0)) throw new FileError(`only text files can be proposed: ${rel}`);
          total += buffer.length;
          if (out.length >= maxFiles) throw new FileError(`too many files (limit ${maxFiles})`);
          if (total > maxBytes) throw new FileError(`too large (limit ${maxBytes} bytes)`);
          out.push({ path: rel, content: buffer.toString("utf8") });
        }
      }
    };
    walk(top, "");
    return out;
  }

  write(input: string, content: string): { path: string; bytes: number } {
    const target = this.absolute(input);
    if (!inside(target, this.workspace) || target === this.workspace) {
      throw new FileError(`writes are only allowed inside the workspace (${this.workspace})`);
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_WRITE) throw new FileError(`content too large (${bytes} bytes, limit ${MAX_WRITE})`);

    // Walk up to the deepest directory that already exists and make sure its
    // real location is still inside the workspace, so a symlink planted in
    // the workspace cannot redirect the write elsewhere.
    let existing = path.dirname(target);
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    if (!inside(fs.realpathSync(existing), this.workspace)) {
      throw new FileError("path leaves the workspace through a symlink");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      if (fs.lstatSync(target).isSymbolicLink()) throw new FileError("refusing to write through a symlink");
    } catch (err) {
      if (err instanceof FileError) throw err;
      // does not exist yet: fine
    }
    fs.writeFileSync(target, content, { mode: 0o640 });
    return { path: target, bytes };
  }
}
