// Giving files to Woody, and taking its results.
//
// The workbench has one folder that Woody, the programs it runs and the
// operator all use (nix/locked/workbench.nix). The operator's side of it is
// here: the HUD lists what is in that folder, takes a file the operator
// gives ("in"), and hands one out for download.
//
// Whatever is in that folder may have been written by a program Woody ran.
// So nothing here trusts a name or follows a link: a path is used only if
// its real location is inside the folder, and a download is always sent as
// plain bytes to save, never as a page to show.
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

export class FilesError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const FILE_LIMITS = {
  /** The most one given file may weigh. The workbench's disk is the real limit. */
  uploadBytes: 4 * 1024 ** 3,
  entries: 500,
  depth: 5,
  name: 150,
};

export type Entry = { path: string; size: number; mtime: number; dir: boolean };

/** A file name that is only a name: no folders, no control characters, not hidden, not too long. */
export function safeName(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/^\.+/, "").trim();
  if (!clean) return "file";
  if (clean.length <= FILE_LIMITS.name) return clean;
  const ext = path.extname(clean).slice(0, 12);
  return clean.slice(0, FILE_LIMITS.name - ext.length) + ext;
}

export class Bench {
  private readonly root: string | null;

  /** `dir` is the workbench's folder. On a machine without a workbench, every request says so. */
  constructor(dir: string | undefined) {
    let root: string | null = null;
    try {
      if (dir) root = fs.realpathSync(dir);
    } catch {
      // Not there (yet): asked again at each request would hide a real problem; say it plainly instead.
    }
    this.root = root;
  }

  get available(): boolean {
    return this.root !== null;
  }

  private need(): string {
    if (!this.root) throw new FilesError("This machine has no workbench folder.", 503);
    return this.root;
  }

  /** Everything in the folder, newest first, without following links. */
  list(): { files: Entry[]; truncated: boolean; free_bytes: number | null } {
    const root = this.need();
    const out: Entry[] = [];
    let truncated = false;
    const walk = (dir: string, rel: string, depth: number) => {
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of names) {
        if (out.length >= FILE_LIMITS.entries) {
          truncated = true;
          return;
        }
        if (e.name.startsWith(".")) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (depth < FILE_LIMITS.depth) walk(path.join(dir, e.name), p, depth + 1);
          else truncated = true;
        } else if (e.isFile()) {
          try {
            const st = fs.statSync(path.join(dir, e.name));
            out.push({ path: p, size: st.size, mtime: st.mtimeMs, dir: false });
          } catch {
            // Gone meanwhile.
          }
        }
        // Links and anything else are not listed: they are not the operator's to take.
      }
    };
    walk(root, "", 0);
    out.sort((a, b) => b.mtime - a.mtime);
    let free: number | null = null;
    try {
      const s = fs.statfsSync(root);
      free = Number(s.bavail) * Number(s.bsize);
    } catch {
      // Not every platform tells.
    }
    return { files: out, truncated, free_bytes: free };
  }

  /** The real location of a listed file. Refuses anything that is not a regular file inside the folder. */
  resolve(rel: string): string {
    const root = this.need();
    if (!rel || rel.includes("\0")) throw new FilesError("which file?");
    const wanted = path.resolve(root, rel);
    if (wanted === root || !wanted.startsWith(root + path.sep)) throw new FilesError("that is not in the workbench", 403);
    let real: string;
    try {
      // A link is refused whatever it points to: the operator takes files, not what a program aimed a link at.
      if (fs.lstatSync(wanted).isSymbolicLink()) throw new FilesError("that is a link, not a file", 403);
      real = fs.realpathSync(wanted);
    } catch (err) {
      if (err instanceof FilesError) throw err;
      throw new FilesError("there is no such file", 404);
    }
    if (!real.startsWith(root + path.sep)) throw new FilesError("that is not in the workbench", 403);
    if (!fs.statSync(real).isFile()) throw new FilesError("that is not a file", 400);
    return real;
  }

  /** Where a given file is kept: the "in" folder, under its own name, or with a number when that name is taken. */
  private targetFor(name: string): string {
    const dir = path.join(this.need(), "in");
    fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
    const clean = safeName(name);
    const ext = path.extname(clean);
    const stem = clean.slice(0, clean.length - ext.length);
    for (let i = 1; i < 1000; i++) {
      const candidate = path.join(dir, i === 1 ? clean : `${stem} (${i})${ext}`);
      if (!fs.existsSync(candidate)) return candidate;
    }
    throw new FilesError("too many files with that name");
  }

  /**
   * Takes a file the operator gives: the request's body is written to the
   * "in" folder. Resolves with the file's path inside the workbench.
   */
  receive(req: http.IncomingMessage, name: string): Promise<{ path: string; bytes: number }> {
    const root = this.need();
    const target = this.targetFor(name);
    const partial = path.join(path.dirname(target), `.upload-${crypto.randomBytes(6).toString("hex")}`);
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(partial, { mode: 0o660, flags: "wx" });
      let bytes = 0;
      let failed = false;
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        req.unpipe(out);
        out.destroy();
        fs.rm(partial, { force: true }, () => reject(err));
      };
      req.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > FILE_LIMITS.uploadBytes) fail(new FilesError("that file is larger than a given file may be", 413));
      });
      req.on("error", () => fail(new FilesError("the upload was interrupted")));
      req.on("aborted", () => fail(new FilesError("the upload was interrupted")));
      out.on("error", (err: NodeJS.ErrnoException) => fail(new FilesError(err.code === "ENOSPC" ? "the workbench's disk is full" : `the file could not be written (${err.code ?? "error"})`, err.code === "ENOSPC" ? 507 : 500)));
      out.on("finish", () => {
        if (failed) return;
        try {
          // Woody and the programs it runs may read and change what the operator gives.
          fs.chmodSync(partial, 0o660);
          fs.renameSync(partial, target);
          resolve({ path: path.relative(root, target).split(path.sep).join("/"), bytes });
        } catch (err) {
          fail(new FilesError(`the file could not be kept (${(err as NodeJS.ErrnoException).code ?? "error"})`, 500));
        }
      });
      req.pipe(out);
    });
  }

  /** The operator removes a file from the workbench. */
  remove(rel: string): void {
    fs.rmSync(this.resolve(rel));
  }
}

/** Sends a file as something to save: plain bytes, with its name, never a page the browser would show or run. */
export function sendDownload(res: http.ServerResponse, file: string): void {
  const name = path.basename(file);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const size = fs.statSync(file).size;
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": size,
    "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "no-store",
  });
  fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
}
