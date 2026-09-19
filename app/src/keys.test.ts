import { isBack, Keys } from './keys';

describe('isBack', () => {
  it('treats the webOS Back key and Escape as back', () => {
    expect(isBack(Keys.Back)).toBe(true);
    expect(isBack(Keys.Escape)).toBe(true);
    expect(isBack(Keys.Enter)).toBe(false);
  });
});
