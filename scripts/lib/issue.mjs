// Reading an "Add a drive" issue (used by scripts/add-drive.mjs).

// Issue forms render as "### Label\n\nvalue".
export function field(body, label) {
  const re = new RegExp(`###\\s*${label}\\s*\\n+([\\s\\S]*?)(?=\\n###|$)`, 'i');
  const v = ((body || '').match(re) || [])[1]?.trim() || '';
  return v === '_No response_' ? '' : v;
}

export const tidy = (s, max) => String(s).replace(/[\r\n\t]+/g, ' ').replace(/[<>`]/g, '').trim().slice(0, max);

const FOLDER_URL = /https:\/\/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|open\?id=)[\w-]{10,}[^\s)<>"']*/i;

// The drive link: the form's field when it's there, otherwise the first Drive folder link written
// anywhere in the issue (title or text), so an issue made without the form still works.
export function findDriveUrl(title, body) {
  const fromField = field(body, 'Drive folder link');
  if (fromField) return fromField.match(/https?:\/\/\S+/)?.[0] || fromField;
  return `${body || ''}\n${title || ''}`.match(FOLDER_URL)?.[0] || '';
}

// Who/what, when they were typed as plain lines ("Who shared it: @x") instead of form fields.
export function plainField(body, label) {
  const m = (body || '').match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : '';
}
