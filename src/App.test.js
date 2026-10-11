import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the smart attention tracker heading', () => {
  render(<App />);
  expect(screen.getByText(/Smart Attention Tracker/i)).toBeInTheDocument();
});
