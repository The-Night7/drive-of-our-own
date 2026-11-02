import test from 'node:test';
import assert from 'node:assert/strict';
import { findDriveUrl, field, plainField } from './issue.mjs';

const URL1 = 'https://drive.google.com/drive/folders/1HAoiBQkUuErQsShH8ooXZwtCGlIPJo6p';

test('reads the link from the form field', () => {
  const body = `### Drive folder link\n\n${URL1}?usp=drive_link\n\n### Who shared it\n\n@x`;
  assert.equal(findDriveUrl('Add drive: @x', body), `${URL1}?usp=drive_link`);
  assert.equal(field(body, 'Who shared it'), '@x');
});

test('finds the link anywhere in the text when there is no form (an issue made without it)', () => {
  assert.equal(findDriveUrl('Add drive: @x', `please add this one ${URL1} thanks`), URL1);
  assert.equal(findDriveUrl(`Add drive ${URL1}`, ''), URL1);
  assert.equal(findDriveUrl('x', 'https://drive.google.com/drive/u/0/folders/1HAoiBQkUuErQsShH8ooXZwtCGlIPJo6p)'), 'https://drive.google.com/drive/u/0/folders/1HAoiBQkUuErQsShH8ooXZwtCGlIPJo6p');
});

test('an empty issue has no link (the bot then asks for one instead of staying silent)', () => {
  assert.equal(findDriveUrl('Add drive: @Holachiri', ''), '');
  assert.equal(findDriveUrl('Add drive: @Holachiri', undefined), '');
  assert.equal(findDriveUrl('Add drive', 'a link to https://example.com/x'), '');
});

test('"_No response_" counts as empty; plain "Label: value" lines are read', () => {
  assert.equal(field('### Who shared it\n\n_No response_', 'Who shared it'), '');
  assert.equal(plainField('Who shared it: @abc\nWhat\'s in it: HP', 'Who shared it'), '@abc');
});
