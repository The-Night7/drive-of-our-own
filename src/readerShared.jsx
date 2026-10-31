// Pieces shared by the PDF and EPUB readers.

export const THEMES = [
  { key: 'paper', label: 'Paper' },
  { key: 'sepia', label: 'Sepia' },
  { key: 'night', label: 'Night' },
];

export const driveUrl = (id) => `https://drive.google.com/file/d/${id}/view`;
export const downloadUrl = (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`; // plain link: works as a download

export const previewUrl = (id) => `https://drive.google.com/file/d/${id}/preview`;

// localStorage can throw (private mode, blocked): the reader must work without it.
export const store = {
  get(key, fallback) {
    try {
      const v = window.localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};


// The relay (api/file.js) streams a Drive file; kind is 'pdf' or 'epub'.
export const relayUrl = (id, kind) => `${window.location.origin}/api/file?id=${id}&kind=${kind}`;

// Raised by the EPUB loader when the relay refuses (same shape pdf.js gives for HTTP errors).
export class RelayError extends Error {
  constructor(status) {
    super(`relay answered ${status}`);
    this.name = 'RelayError';
    this.status = status;
  }
}

export function Progress({ loaded, total }) {
  const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : null;
  return (
    <div className="reader-progress" role="progressbar" aria-valuenow={pct ?? undefined} aria-label="Loading">
      <div className="reader-progress-bar" style={pct === null ? { width: '35%', animation: 'rp 1.1s ease-in-out infinite' } : { width: `${pct}%` }} />
      <span>{pct === null ? `Loading… ${(loaded / 1048576).toFixed(1)} MB` : `Loading… ${pct}% of ${(total / 1048576).toFixed(1)} MB`}</span>
    </div>
  );
}

export function Outline({ items, onOpen, depth = 0 }) {
  return (
    <ul className={`outline outline-${Math.min(depth, 3)}`}>
      {items.map((it, i) => (
        <li key={i}>
          <button onClick={() => onOpen(it)}>{it.title}</button>
          {it.items?.length ? <Outline items={it.items} onOpen={onOpen} depth={depth + 1} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function Fallback({ fileId, error, kind = 'pdf' }) {
  const name = error?.name || '';
  const status = error?.status;
  const label = kind === 'epub' ? 'EPUB' : 'PDF';
  // pdf.js turns an HTTP 404 into MissingPDFException (no status), other codes keep theirs.
  const why =
    status === 404 || name === 'MissingPDFException'
      ? "This file isn't public (or no longer exists): Google asks for a sign-in, so it can't be opened here."
      : status === 429
        ? "Google's download limit for this file has been reached for now. Try again later."
        : status === 413
          ? 'This file is too large for the built-in reader.'
          : status === 415 || name === 'InvalidPDFException' || name === 'EpubError'
            ? `This file isn't a readable ${label}.`
            : "The reader couldn't get this file from Google Drive.";
  // Google's own viewer can show a PDF, but not an EPUB.
  const viewer = kind === 'pdf';
  return (
    <div className="reader-fallback">
      <div className="reader-fallback-msg">
        <strong>Can't use the built-in reader for this one.</strong>
        <span>
          {why}
          {viewer ? " Google's own viewer is shown below instead, when it can." : ' You can still open it in Google Drive or download it.'}
        </span>
        <span className="reader-fallback-links">
          <a href={driveUrl(fileId)} target="_blank" rel="noreferrer">
            Open in Google Drive ↗
          </a>
          <a href={downloadUrl(fileId)}>Download</a>
        </span>
      </div>
      {viewer && <iframe title="Google Drive viewer" src={previewUrl(fileId)} allow="fullscreen" />}
    </div>
  );
}
