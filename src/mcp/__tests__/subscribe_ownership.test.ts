/**
 * Tests for issue #303: resources/subscribe inbox ownership check.
 *
 * `assertSubscribeOwnership` は pure function として export されているため、
 * HTTP server を立ち上げずに unit test できる。
 */

import { describe, it, expect } from 'vitest';
import { assertSubscribeOwnership } from '../server.js';

describe('assertSubscribeOwnership (issue #303)', () => {
  it('自分の inbox URI は成功する', () => {
    expect(() => assertSubscribeOwnership('@alice', 'inbox://alice')).not.toThrow();
  });

  it('@-prefix 付き canonical URI でも自分の inbox なら成功する', () => {
    expect(() => assertSubscribeOwnership('@alice', 'inbox://@alice')).not.toThrow();
  });

  it('他ユーザーの inbox URI は forbidden エラーになる', () => {
    expect(() => assertSubscribeOwnership('@bob', 'inbox://alice')).toThrow(
      'forbidden: cannot subscribe another user\'s inbox'
    );
  });

  it('inbox:// でない URI はチェックをスキップして成功する', () => {
    expect(() => assertSubscribeOwnership('@alice', 'other://something')).not.toThrow();
  });
});
