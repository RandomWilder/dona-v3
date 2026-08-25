import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeHtml, Html, h } from './html.ts';

describe('escapeHtml', () => {
  it('escapes each of the five characters', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('>'), '&gt;');
    assert.equal(escapeHtml('"'), '&quot;');
    assert.equal(escapeHtml("'"), '&#39;');
  });

  it('escapes an ampersand once, not twice', () => {
    // The failure this orders the replacements against: escape `<` first and
    // the ampersand of `&lt;` gets escaped by the next pass, yielding
    // `&amp;lt;` — which renders as the literal text `&lt;` on the page.
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  });

  it('leaves Hebrew and ordinary text alone', () => {
    assert.equal(escapeHtml('רחוב הרצל 12א'), 'רחוב הרצל 12א');
  });

  it('escapes every occurrence, not just the first', () => {
    assert.equal(escapeHtml('<<'), '&lt;&lt;');
  });
});

describe('h', () => {
  it('passes literals through and escapes interpolations', () => {
    const name = '<b>Dana</b>';
    assert.equal(h`<p>${name}</p>`.value, '<p>&lt;b&gt;Dana&lt;/b&gt;</p>');
  });

  it('renders a person named like a script tag inert', () => {
    // The case the whole rule exists for. A display name is free text typed by
    // an operator or landed by the day-8 importer, and it reaches a page.
    const displayName = '<script>alert(1)</script>';
    const page = h`<td>${displayName}</td>`.value;
    assert.ok(!page.includes('<script>'));
    assert.equal(page, '<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>');
  });

  it('cannot be broken out of an attribute', () => {
    const evil = '" onmouseover="steal()';
    const page = h`<a title="${evil}">x</a>`.value;
    assert.ok(!page.includes('onmouseover="steal()"'));
    assert.ok(page.includes('&quot;'));
  });

  it('splices nested Html instead of escaping it twice', () => {
    const row = h`<li>${'a & b'}</li>`;
    assert.equal(h`<ul>${row}</ul>`.value, '<ul><li>a &amp; b</li></ul>');
  });

  it('joins an array of rows', () => {
    const rows = ['<x>', 'y'].map((v) => h`<li>${v}</li>`);
    assert.equal(
      h`<ul>${rows}</ul>`.value,
      '<ul><li>&lt;x&gt;</li><li>y</li></ul>',
    );
  });

  it('renders null and undefined as nothing, not as their names', () => {
    // A nullable floor or end date interpolates directly; "null" on the page
    // would be a bug the reader has to decode.
    assert.equal(h`<td>${null}</td>`.value, '<td></td>');
    assert.equal(h`<td>${undefined}</td>`.value, '<td></td>');
  });

  it('renders numbers', () => {
    assert.equal(h`<td>${3}</td>`.value, '<td>3</td>');
    assert.equal(h`<td>${0}</td>`.value, '<td>0</td>');
  });

  it('refuses to render an object rather than printing [object Object]', () => {
    assert.throws(() => h`<td>${{ a: 1 }}</td>`, TypeError);
  });

  it('returns Html, so a result can be composed', () => {
    assert.ok(h`<p></p>` instanceof Html);
  });
});
