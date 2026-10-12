'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('PROCESS-006 AC2 throwaway: deliberately red', () => {
  assert.fail('PROCESS-006 AC2 throwaway');
});
