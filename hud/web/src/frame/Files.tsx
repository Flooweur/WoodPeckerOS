// Files, as a record: what is in Woody's workbench, giving it a file, and
// taking a result. The workbench is where Woody runs programs; its "in"
// folder is where you put files for it, its "out" folder where it leaves
// results. Woody is told about a file you give the next time you speak to it.
import { useCallback, useEffect, useRef, useState } from "react";
import { day } from "./types";

type Entry = { path: string; size: number; mtime: number };
type Listing = { available: boolean; files: Entry[]; truncated: boolean; free_bytes: number | null };
type Upload = { name: string; done: number; total: number; error?: string };

const size = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The kiosk has no session cookie: its requests carry the token the page was given. */
const headers = (): Record<string, string> => {
  const token = sessionStorage.getItem("woody-token");
  return token ? { "x-woody-token": token } : {};
};

/** Sends one file to the workbench's "in" folder, reporting how far it is. */
export function giveFile(file: File, onProgress: (done: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/files/put?name=${encodeURIComponent(file.name)}`);
    for (const [k, v] of Object.entries(headers())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status === 200) return resolve();
      let message = `refused (${xhr.status})`;
      try {
        message = JSON.parse(xhr.responseText).error ?? message;
      } catch {
        // Not JSON: keep the status.
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("the connection was lost"));
    xhr.send(file);
  });
}

export function FilesRecord({ tick, dropped }: { tick: number; dropped: File[] }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  /** On the VM's own screen there is nowhere to save a file to, and nothing of yours to give. */
  const ownBrowser = location.protocol === "https:";

  const load = useCallback(() => {
    fetch("/files/list", { headers: headers() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`refused (${r.status})`))))
      .then((l: Listing) => {
        setListing(l);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  // Asked again whenever the gateway says the folder changed, or a session of Woody's ended.
  useEffect(load, [load, tick]);

  const give = useCallback(
    (files: File[]) => {
      for (const file of files) {
        setUploads((u) => [...u, { name: file.name, done: 0, total: file.size }]);
        const update = (patch: Partial<Upload>) => setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, ...patch } : x)));
        giveFile(file, (done) => update({ done }))
          .then(() => {
            setUploads((u) => u.filter((x) => x.name !== file.name));
            load();
          })
          .catch((e: Error) => update({ error: e.message }));
      }
    },
    [load],
  );
  // Files dropped anywhere on the screen arrive here.
  useEffect(() => {
    if (dropped.length) give(dropped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);

  const remove = (path: string) => {
    fetch(`/files/delete?path=${encodeURIComponent(path)}`, { method: "POST", headers: headers() })
      .then((r) => (r.ok ? load() : r.json().then((b) => setError(b.error ?? "could not remove it"))))
      .catch((e: Error) => setError(e.message));
  };

  if (!listing) return <p className="dim">{error || "…"}</p>;
  if (!listing.available) return <p className="dim">This machine has no workbench, so there is nowhere to exchange files with Woody.</p>;

  const given = listing.files.filter((f) => f.path.startsWith("in/"));
  const results = listing.files.filter((f) => f.path.startsWith("out/"));
  const other = listing.files.filter((f) => !f.path.startsWith("in/") && !f.path.startsWith("out/"));
  const group = (title: string, hint: string, files: Entry[]) => (
    <>
      <h4>{title}</h4>
      {files.length === 0 && <p className="dim small">{hint}</p>}
      {files.map((f) => (
        <div key={f.path} className="file-row">
          <span className="one">{f.path.replace(/^(in|out)\//, "")}</span>
          <span className="small dim">
            {size(f.size)} · {day(f.mtime)}
          </span>
          <span className="row-actions">
            {ownBrowser && (
              <a className="button" href={`/files/get?path=${encodeURIComponent(f.path)}`} download>
                download
              </a>
            )}
            <button className="ghost" onClick={() => remove(f.path)}>
              remove
            </button>
          </span>
        </div>
      ))}
    </>
  );

  return (
    <div className="stack wide files">
      <p className="small">
        Woody has a workbench where it runs programs. Give it a file here and it can work on it; what it makes for you appears under "From Woody". Woody is told about a file the next time you speak to it.
        {listing.free_bytes !== null && <span className="dim"> {size(listing.free_bytes)} free.</span>}
      </p>
      <div className="row-actions">
        <input ref={picker} type="file" multiple hidden onChange={(e) => (give([...(e.target.files ?? [])]), (e.target.value = ""))} />
        <button className="primary" onClick={() => picker.current?.click()}>
          give Woody a file
        </button>
        <span className="dim small">{ownBrowser ? "or drop files anywhere on this page" : "from your own browser, you can also download what Woody made"}</span>
      </div>
      {uploads.map((u) => (
        <div key={u.name} className="file-row">
          <span className="one">{u.name}</span>
          <span className={`small ${u.error ? "red" : "dim"}`}>{u.error ? `not given: ${u.error}` : `${Math.round((100 * u.done) / Math.max(1, u.total))}% of ${size(u.total)}`}</span>
          {u.error && (
            <button className="ghost" onClick={() => setUploads((x) => x.filter((y) => y.name !== u.name))}>
              dismiss
            </button>
          )}
        </div>
      ))}
      {error && <p className="red small">{error}</p>}
      {group("From Woody", "Nothing yet. Ask Woody to leave a result in its out folder.", results)}
      {group("Given to Woody", "Nothing yet.", given)}
      {other.length > 0 && group("Elsewhere in the workbench", "", other)}
      {listing.truncated && <p className="dim small">There are more files than are listed here.</p>}
    </div>
  );
}
