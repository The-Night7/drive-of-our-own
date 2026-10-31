import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanStyle, resolvePath } from '../../src/epub.js';

test('inline style keeps only safe typography', () => {
  assert.equal(cleanStyle('text-align: center; font-weight:bold'), 'text-align:center;font-weight:bold');
  assert.equal(cleanStyle('background:url(http://evil.test/x); position:fixed; color:red'), '');
  assert.equal(cleanStyle('text-align:center; position:fixed'), 'text-align:center');
  assert.equal(cleanStyle('font-style: italic !important'), 'font-style:italic');
  assert.equal(cleanStyle('text-indent: expression(alert(1))'), '');
  assert.equal(cleanStyle('text-decoration: underline line-through'), 'text-decoration:underline line-through');
});

test('links and images resolve inside the zip', () => {
  assert.equal(resolvePath('OEBPS/ch1.xhtml', 'ch2.xhtml#top'), 'OEBPS/ch2.xhtml');
  assert.equal(resolvePath('OEBPS/text/ch1.xhtml', '../images/a%20b.png'), 'OEBPS/images/a b.png');
  assert.equal(resolvePath('ch1.xhtml', 'sub/./x.png'), 'sub/x.png');
  assert.equal(resolvePath('OEBPS/ch1.xhtml', '/abs/p.png'), 'abs/p.png');
  assert.equal(resolvePath('a/b.xhtml', '../../../../etc/passwd'), 'etc/passwd'); // can't climb out of the zip
});
