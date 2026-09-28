import { fireEvent, render } from '@testing-library/react';
import { layerImageUrl } from '../../config';
import { LayerImage } from './LayerImage';

describe('LayerImage', () => {
  it('asks cthulhu for the given layer', () => {
    const { container } = render(<LayerImage layer={218} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(layerImageUrl(218));
  });

  it('is decoration: the status region already announces the layer', () => {
    const { container } = render(<LayerImage layer={218} />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('aria-hidden')).toBe('true');
  });

  it('hides when cthulhu has no image yet (202 while fetching, 404 when idle)', () => {
    const { container } = render(<LayerImage layer={218} />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
  });

  it('tries again on the next layer, once cthulhu may have the file', () => {
    const { container, rerender } = render(<LayerImage layer={218} />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    rerender(<LayerImage layer={219} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(layerImageUrl(219));
  });
});
