'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { slugify } = require('./slugify');

test('lowercases text', () => {
  assert.equal(slugify('Hello'), 'hello');
});

test('trims surrounding whitespace', () => {
  assert.equal(slugify('  hello  '), 'hello');
});

test('replaces a non-alphanumeric separator', () => {
  assert.equal(slugify('hello_world'), 'hello-world');
});

test('strips leading and trailing separators', () => {
  assert.equal(slugify('--hello--'), 'hello');
});

test('collapses repeated separators', () => {
  assert.equal(slugify('a  b'), 'a-b');
});
