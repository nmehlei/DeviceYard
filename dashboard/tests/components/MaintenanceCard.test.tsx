import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { MaintenanceCard } from '../../src/components/MaintenanceCard';
import * as api from '../../src/lib/api';
jest.mock('../../src/lib/api', () => ({ ...jest.requireActual('../../src/lib/api'), fetchMaintenance: jest.fn(), setMaintenance: jest.fn() }));
const normal = { requested: false, state: 'normal', runningJobs: 0, activeOperations: 0, activeStreams: 0 };
beforeEach(() => { jest.resetAllMocks(); (api.fetchMaintenance as jest.Mock).mockResolvedValue(normal); });
test('admin can start draining and resume while jobs still finish', async () => {
  (api.setMaintenance as jest.Mock).mockResolvedValueOnce({ ...normal, requested: true, state: 'draining', runningJobs: 2 }).mockResolvedValueOnce(normal);
  render(<MaintenanceCard />);
  await screen.findByText('Normal operation');
  fireEvent.click(await screen.findByRole('button', { name: 'Enable maintenance' }));
  expect(await screen.findByText('Draining')).toBeInTheDocument();
  expect(screen.getByText(/2 running jobs/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  expect(await screen.findByRole('button', { name: 'Enable maintenance' })).toBeEnabled();
});
test('shows readiness and a failed resume without claiming normal operation', async () => {
  (api.fetchMaintenance as jest.Mock).mockResolvedValue({ ...normal, requested: true, state: 'ready' });
  (api.setMaintenance as jest.Mock).mockRejectedValue(new Error('unavailable'));
  render(<MaintenanceCard />);
  expect(await screen.findByText('Ready for maintenance')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not change maintenance mode');
  expect(screen.getByText('Ready for maintenance')).toBeInTheDocument();
});
