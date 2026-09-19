import { act, fireEvent, render, screen } from '@testing-library/react';
import { CONFIG } from '../../config';
import { PrinterCam } from './PrinterCam';

describe('PrinterCam', () => {
  it('shows the Leia stream full-screen with a connecting overlay', () => {
    render(<PrinterCam />);
    const img = screen.getByRole('img', { name: '3D printer camera' });
    expect(img.getAttribute('src')).toContain(CONFIG.printerCam.streamUrl);
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to printer…');
  });

  it('hides the overlay once frames arrive', () => {
    render(<PrinterCam />);
    act(() => {
      fireEvent.load(screen.getByRole('img'));
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
